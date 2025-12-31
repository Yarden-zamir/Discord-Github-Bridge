const { Events } = require("discord.js");
const { Octokit } = require("octokit");
const { env } = require("process");
const { setGlobalDispatcher, Agent, Pool } = require("undici");
const {
  createDiscordClient,
  isForumThread,
  processMessageContent,
  getSyncedIssueNumbers,
  formatDiscordAuthorComment,
  createSyncEmbed,
  getRepoOwner,
  getRepoName,
  SYNC_LABEL,
  isSyncLabel,
  sleep,
  getOrCreateGitHubLabel,
} = require("./utils.js");

setGlobalDispatcher(
  new Agent({
    connect: { rejectUnauthorized: false, timeout: 60_000 },
    factory: (origin) => new Pool(origin, { connections: 128 }),
  })
);

const app = require("express")();
app.use("/healthcheck", require("express-healthcheck")());
const PORT = env.PORT || 8080;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

function createOctokit() {
  return new Octokit({ auth: env.GITHUB_TOKEN });
}

async function handleNewMessage(message) {
  try {
    if (!isForumThread(message.channel)) return;

    const starterMessage = await message.channel.fetchStarterMessage();
    if (!starterMessage || message.id === starterMessage.id || message.author.bot) return;

    const issueNumbers = await getSyncedIssueNumbers(message.channel);
    if (issueNumbers.length === 0) return;

    const octokit = createOctokit();
    const body = formatDiscordAuthorComment(
      message.author,
      message.url,
      processMessageContent(message)
    );

    for (const issueNumber of issueNumbers) {
      await octokit.rest.issues.createComment({
        owner: getRepoOwner(),
        repo: getRepoName(),
        issue_number: issueNumber,
        body,
      });
    }
  } catch (err) {
    console.error("Error handling new message:", err);
  }
}

async function handleThreadUpdate(oldThread, newThread) {
  try {
    if (!isForumThread(newThread)) return;

    const issueNumbers = await getSyncedIssueNumbers(newThread);
    if (issueNumbers.length === 0) return;

    const octokit = createOctokit();

    // Handle archive state change
    if (oldThread.archived !== newThread.archived) {
      const state = newThread.archived ? "closed" : "open";
      for (const issueNumber of issueNumbers) {
        console.log(`${newThread.archived ? "Closing" : "Reopening"} issue #${issueNumber}`);
        await octokit.rest.issues.update({
          owner: getRepoOwner(),
          repo: getRepoName(),
          issue_number: issueNumber,
          state,
        });
      }
    }

    // Handle tag changes
    const oldTags = oldThread.appliedTags || [];
    const newTags = newThread.appliedTags || [];

    if (JSON.stringify([...oldTags].sort()) === JSON.stringify([...newTags].sort())) return;

    const forum = await newThread.client.channels.fetch(env.DISCORD_INPUT_FORUM_CHANNEL_ID);
    const tagMap = new Map(forum.availableTags.map((t) => [t.id, t.name]));

    const addedTagIds = newTags.filter((id) => !oldTags.includes(id));
    const removedTagIds = oldTags.filter((id) => !newTags.includes(id));

    for (const issueNumber of issueNumbers) {
      // Add labels for new tags
      for (const tagId of addedTagIds) {
        const tagName = tagMap.get(tagId);
        if (!tagName || isSyncLabel(tagName)) continue;

        console.log(`Adding label "${tagName}" to issue #${issueNumber}`);
        await getOrCreateGitHubLabel(octokit, tagName);
        await octokit.rest.issues.addLabels({
          owner: getRepoOwner(),
          repo: getRepoName(),
          issue_number: issueNumber,
          labels: [tagName],
        });
      }

      // Remove labels for removed tags
      for (const tagId of removedTagIds) {
        const tagName = tagMap.get(tagId);
        if (!tagName || isSyncLabel(tagName)) continue;

        console.log(`Removing label "${tagName}" from issue #${issueNumber}`);
        try {
          await octokit.rest.issues.removeLabel({
            owner: getRepoOwner(),
            repo: getRepoName(),
            issue_number: issueNumber,
            name: tagName,
          });
        } catch (err) {
          if (err.status !== 404) throw err;
        }
      }
    }
  } catch (err) {
    console.error("Error handling thread update:", err);
  }
}

async function handleNewThread(thread) {
  try {
    console.log("Thread created");
    await sleep(500);

    const message = await thread.fetchStarterMessage();
    if (!message || !isForumThread(message.channel)) return;
    if (message.author.bot) return;
    if (message.content.startsWith("`synced with issue #")) return;

    console.log(`Processing: ${message.content}`);

    const octokit = createOctokit();

    // Get initial tags and convert to labels
    const appliedTags = thread.appliedTags || [];
    const forum = await thread.client.channels.fetch(env.DISCORD_INPUT_FORUM_CHANNEL_ID);
    const tagNames = appliedTags
      .map((id) => forum.availableTags.find((t) => t.id === id)?.name)
      .filter((name) => name && !isSyncLabel(name));

    // Create labels that don't exist (including sync label)
    await getOrCreateGitHubLabel(octokit, SYNC_LABEL);
    for (const tagName of tagNames) {
      await getOrCreateGitHubLabel(octokit, tagName);
    }

    const issue = await octokit.rest.issues.create({
      owner: getRepoOwner(),
      repo: getRepoName(),
      title: message.channel.name,
      body: formatDiscordAuthorComment(
        message.author,
        message.url,
        processMessageContent(message)
      ),
      labels: [SYNC_LABEL, ...tagNames],
    });

    const syncMessage = createSyncEmbed(
      issue.data.number,
      issue.data.title,
      message.content,
      issue.data.html_url,
      {
        name: message.author.username,
        iconUrl: message.author.avatarURL() || message.author.defaultAvatarURL,
      }
    );

    const sentMessage = await thread.send(syncMessage);
    await sentMessage.pin();
  } catch (err) {
    console.error("Error handling new thread:", err);
  }
}

function start() {
  const client = createDiscordClient();

  client.on(Events.MessageCreate, handleNewMessage);
  client.on(Events.ThreadCreate, handleNewThread);
  client.on(Events.ThreadUpdate, handleThreadUpdate);

  client.login(env.DISCORD_TOKEN).catch((err) => {
    console.error("Discord login failed:", err);
    process.exit(1);
  });
}

module.exports = { start };
