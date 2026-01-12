const { Events } = require("discord.js");
const { env } = require("process");
const { setGlobalDispatcher, Agent, Pool } = require("undici");
const {
  createDiscordClient,
  isForumThread,
  processMessageContent,
  getSyncedIssueInfo,
  getSyncedIssueNumbers,
  formatDiscordAuthorComment,
  createSyncEmbed,
  getRepoOwner,
  getRepoName,
  SYNC_LABEL,
  isSyncLabel,
  sleep,
  getOrCreateGitHubLabel,
  getOrCreateForumTag,
  setTargetRepo,
} = require("./utils.js");
const { getWebhooks, getWebhookMiddleware, getInstallationOctokit } = require("./githubApp.js");
const {
  handleIssueComment,
  handleIssueOpened,
  handleIssueClosed,
  handleIssueReopened,
  handleIssueLabeled,
  handleIssueUnlabeled,
  handleIssueMilestoned,
  handleIssueAssigned,
} = require("./payloadProcessor.js");

setGlobalDispatcher(
  new Agent({
    connect: { rejectUnauthorized: false, timeout: 60_000 },
    factory: (origin) => new Pool(origin, { connections: 128 }),
  })
);

const express = require("express");
const expressApp = express();

expressApp.use("/healthcheck", require("express-healthcheck")());

const PORT = env.PORT || 8080;

// Store installation ID from webhooks for Discord → GitHub operations
let lastInstallationId = env.GITHUB_INSTALLATION_ID || null;

async function getOctokit() {
  if (!lastInstallationId) {
    throw new Error("No installation ID available. Webhook must be received first or set GITHUB_INSTALLATION_ID env var.");
  }
  return getInstallationOctokit(lastInstallationId);
}

// Initialize GitHub App and register webhook handlers
function setupWebhooks() {
  const webhooks = getWebhooks();

  // Wrap handlers to inject octokit from installation ID
  const wrapHandler = (handler) => async (context) => {
    const installationId = context.payload.installation?.id;
    if (installationId) {
      lastInstallationId = installationId;
      const octokit = await getInstallationOctokit(installationId);
      await handler({ octokit, payload: context.payload });
    } else {
      console.warn("No installation ID in webhook payload");
      await handler({ octokit: null, payload: context.payload });
    }
  };

  // Issue events
  webhooks.on("issues.opened", wrapHandler(handleIssueOpened));
  webhooks.on("issues.closed", wrapHandler(handleIssueClosed));
  webhooks.on("issues.reopened", wrapHandler(handleIssueReopened));
  webhooks.on("issues.labeled", wrapHandler(handleIssueLabeled));
  webhooks.on("issues.unlabeled", wrapHandler(handleIssueUnlabeled));
  webhooks.on("issues.milestoned", wrapHandler(handleIssueMilestoned));
  webhooks.on("issues.assigned", wrapHandler(handleIssueAssigned));

  // Comment events
  webhooks.on("issue_comment.created", wrapHandler(handleIssueComment));

  // Error handling
  webhooks.onError((error) => {
    console.error("Webhook error:", error);
  });

  // Use the middleware
  expressApp.use(getWebhookMiddleware());

  console.log("Webhook handlers registered");
}

expressApp.listen(PORT, () => console.log(`Server running on port ${PORT}`));

function extractDiscordUsername(commentBody) {
  const match = commentBody.match(/\*\*(.+?)\*\* on Discord says\]/);
  return match ? match[1] : null;
}

async function handleNewMessage(message) {
  try {
    if (!isForumThread(message.channel)) return;

    const starterMessage = await message.channel.fetchStarterMessage();
    if (!starterMessage || message.id === starterMessage.id || message.author.bot) return;

    const syncedIssues = await getSyncedIssueInfo(message.channel);
    if (syncedIssues.length === 0) return;

    const octokit = await getOctokit();
    const newContent = processMessageContent(message);

    // Add repo tags for any synced repos that aren't tagged yet
    const forum = await message.client.channels.fetch(env.DISCORD_INPUT_FORUM_CHANNEL_ID);
    const thread = message.channel;
    const currentTags = thread.appliedTags || [];
    const reposToTag = [...new Set(syncedIssues.map((i) => i.repo).filter(Boolean))];

    for (const repoName of reposToTag) {
      const repoTag = await getOrCreateForumTag(forum, repoName);
      if (repoTag && !currentTags.includes(repoTag.id) && currentTags.length < 5) {
        console.log(`Adding repo tag "${repoName}" to thread`);
        currentTags.push(repoTag.id);
        await thread.setAppliedTags(currentTags);
      }
    }

    for (const { number: issueNumber, owner: issueOwner, repo: repoName } of syncedIssues) {
      // Use owner/repo from pinned message, fall back to env
      const owner = issueOwner || getRepoOwner();
      const repo = repoName || getRepoName();

      const { data: issue } = await octokit.request("GET /repos/{owner}/{repo}/issues/{issue_number}", {
        owner,
        repo,
        issue_number: issueNumber,
      });

      console.log(`Issue #${issueNumber} on ${repo} has ${issue.comments} comments`);

      let lastComment = null;
      if (issue.comments > 0) {
        const lastPage = Math.ceil(issue.comments / 100);
        const { data: comments } = await octokit.request("GET /repos/{owner}/{repo}/issues/{issue_number}/comments", {
          owner,
          repo,
          issue_number: issueNumber,
          per_page: 100,
          page: lastPage,
        });
        lastComment = comments.at(-1);
      }

      const lastCommentAuthor = lastComment ? extractDiscordUsername(lastComment.body) : null;
      console.log(`Last author: "${lastCommentAuthor}", current: "${message.author.username}"`);

      if (lastComment && lastCommentAuthor === message.author.username) {
        console.log(`Appending to existing comment for ${message.author.username}`);
        await octokit.request("PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}", {
          owner,
          repo,
          comment_id: lastComment.id,
          body: `${lastComment.body}\n${newContent}`,
        });
      } else {
        await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
          owner,
          repo,
          issue_number: issueNumber,
          body: formatDiscordAuthorComment(message.author, message.url, newContent),
        });
      }
    }
  } catch (err) {
    console.error("Error handling new message:", err);
  }
}

async function handleThreadUpdate(oldThread, newThread) {
  try {
    if (!isForumThread(newThread)) return;

    const syncedIssues = await getSyncedIssueInfo(newThread);
    if (syncedIssues.length === 0) return;

    const octokit = await getOctokit();

    // Handle archive state change
    if (oldThread.archived !== newThread.archived) {
      const state = newThread.archived ? "closed" : "open";
      for (const { number: issueNumber, owner: issueOwner, repo: repoName } of syncedIssues) {
        const owner = issueOwner || getRepoOwner();
        const repo = repoName || getRepoName();
        console.log(`${newThread.archived ? "Closing" : "Reopening"} issue #${issueNumber} on ${owner}/${repo}`);
        await octokit.request("PATCH /repos/{owner}/{repo}/issues/{issue_number}", {
          owner,
          repo,
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

    // Get all repo names from synced issues to filter repo tags
    const syncedRepoNames = new Set(syncedIssues.map((i) => i.repo).filter(Boolean));
    const isRepoTag = (name) => syncedRepoNames.has(name);

    for (const { number: issueNumber, owner: issueOwner, repo: repoName } of syncedIssues) {
      const owner = issueOwner || getRepoOwner();
      const repo = repoName || getRepoName();

      // Set target repo for helper functions
      setTargetRepo(`${owner}/${repo}`);

      for (const tagId of addedTagIds) {
        const tagName = tagMap.get(tagId);
        if (!tagName || isSyncLabel(tagName) || isRepoTag(tagName)) continue;

        console.log(`Adding label "${tagName}" to issue #${issueNumber} on ${owner}/${repo}`);
        await getOrCreateGitHubLabel(octokit, tagName);
        await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/labels", {
          owner,
          repo,
          issue_number: issueNumber,
          labels: [tagName],
        });
      }

      for (const tagId of removedTagIds) {
        const tagName = tagMap.get(tagId);
        if (!tagName || isSyncLabel(tagName) || isRepoTag(tagName)) continue;

        console.log(`Removing label "${tagName}" from issue #${issueNumber} on ${owner}/${repo}`);
        try {
          await octokit.request("DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}", {
            owner,
            repo,
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
    if (message.content.startsWith("`Synced with issue #")) return;

    console.log(`Processing: ${message.content}`);

    const octokit = await getOctokit();
    const defaultRepoName = getRepoName();

    const appliedTags = thread.appliedTags || [];
    const forum = await thread.client.channels.fetch(env.DISCORD_INPUT_FORUM_CHANNEL_ID);

    // Get tag names (excluding sync label)
    const allTagNames = appliedTags
      .map((id) => forum.availableTags.find((t) => t.id === id)?.name)
      .filter((name) => name && !isSyncLabel(name));

    // Check if any tag is a different repo name (use first found)
    // Repo tags are exact repo names, not the default repo
    const repoTagName = allTagNames.find((name) => name !== defaultRepoName);
    const repoName = repoTagName || defaultRepoName;

    console.log(`Target repo: ${repoName}${repoTagName ? ' (from tag)' : ' (default)'}`);

    // Set target repo for helper functions (keep same owner)
    setTargetRepo(`${getRepoOwner()}/${repoName}`);

    // Filter tags for GitHub labels: exclude repo tags
    const tagNames = allTagNames.filter((name) => name !== repoName);

    await getOrCreateGitHubLabel(octokit, SYNC_LABEL);
    for (const tagName of tagNames) {
      await getOrCreateGitHubLabel(octokit, tagName);
    }

    const { data: issue } = await octokit.request("POST /repos/{owner}/{repo}/issues", {
      owner: getRepoOwner(),
      repo: repoName,
      title: message.channel.name,
      body: formatDiscordAuthorComment(
        message.author,
        message.url,
        processMessageContent(message)
      ),
      labels: [SYNC_LABEL, ...tagNames],
    });

    // Add repo tag to thread
    const repoTag = await getOrCreateForumTag(forum, repoName);
    if (repoTag && !appliedTags.includes(repoTag.id)) {
      const newTags = [repoTag.id, ...appliedTags].slice(0, 5);
      await thread.setAppliedTags(newTags);
    }

    const syncMessage = createSyncEmbed(
      issue.number,
      issue.title,
      message.content,
      issue.html_url,
      {
        name: message.author.username,
        iconUrl: message.author.avatarURL() || message.author.defaultAvatarURL,
      },
      repoName
    );

    const sentMessage = await thread.send(syncMessage);
    await sentMessage.pin();
  } catch (err) {
    console.error("Error handling new thread:", err);
  }
}

function start() {
  // Setup GitHub App webhooks
  setupWebhooks();

  // Start Discord client
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
