const { Events } = require("discord.js");
const { Octokit } = require("octokit");
const { env } = require("process");
const {
  createDiscordClient,
  createSyncEmbed,
  createCommentEmbed,
  hasSyncLabel,
  isSyncLabel,
  getRepoOwner,
  getRepoName,
  SYNC_LABEL,
  sleep,
  findThreadsForIssue,
  getOrCreateForumTag,
} = require("./utils.js");

function createOctokit() {
  return new Octokit({ auth: env.GITHUB_TOKEN });
}

function isIgnoredComment(comment) {
  return (
    comment.user.login === "Discord-Github-Bridge" ||
    comment.body.includes("** on Discord says]")
  );
}


async function createDiscordThread(client, payload) {
  const issue = payload.event.issue;
  const channel = await client.channels.fetch(env.DISCORD_INPUT_FORUM_CHANNEL_ID);

  console.log(`Creating thread for issue #${issue.number}`);

  const syncMessage = createSyncEmbed(
    issue.number,
    issue.title,
    issue.body,
    issue.html_url,
    {
      name: issue.user.login,
      iconUrl: issue.user.avatar_url,
      url: issue.user.html_url,
    }
  );

  const thread = await channel.threads.create({
    name: issue.title,
    message: syncMessage,
  });

  const starterMessage = await thread.fetchStarterMessage();
  await starterMessage.pin();

  return thread;
}

async function handleNewComment(client, payload) {
  const issue = payload.event.issue;
  const comment = payload.event.comment;

  if (isIgnoredComment(comment)) {
    console.log("Ignoring bot comment");
    return;
  }

  if (!hasSyncLabel(issue)) {
    const octokit = createOctokit();
    await octokit.rest.issues.addLabels({
      owner: getRepoOwner(),
      repo: getRepoName(),
      issue_number: issue.number,
      labels: [SYNC_LABEL],
    });
    console.log("Added sync label");
    await createDiscordThread(client, payload);
    await sleep(2000);
  }

  const threads = await findThreadsForIssue(
    client,
    env.DISCORD_INPUT_FORUM_CHANNEL_ID,
    issue.number
  );

  for (const thread of threads) {
    console.log(`Syncing comment to issue #${issue.number}`);
    await thread.send(createCommentEmbed(comment));
  }

  console.log("Comment sync complete");
}

async function handleNewIssue(client, payload) {
  const octokit = createOctokit();
  const issueNumber = payload.event.issue?.number || payload.event.number;

  const { data: issue } = await octokit.rest.issues.get({
    owner: getRepoOwner(),
    repo: getRepoName(),
    issue_number: issueNumber,
  });

  if (hasSyncLabel(issue)) {
    console.log("Issue already synced");
    return;
  }

  await octokit.rest.issues.addLabels({
    owner: getRepoOwner(),
    repo: getRepoName(),
    issue_number: payload.event.issue.number,
    labels: [SYNC_LABEL],
  });

  await createDiscordThread(client, payload);
}

async function handleIssueClosed(client, payload) {
  const issue = payload.event.issue;
  const threads = await findThreadsForIssue(
    client,
    env.DISCORD_INPUT_FORUM_CHANNEL_ID,
    issue.number
  );

  for (const thread of threads) {
    if (!thread.archived) {
      console.log(`Archiving thread for issue #${issue.number}`);
      await thread.setArchived(true, `Issue #${issue.number} closed on GitHub`);
    }
  }

  console.log(`Archived ${threads.length} thread(s)`);
}

async function handleIssueReopened(client, payload) {
  const issue = payload.event.issue;
  const threads = await findThreadsForIssue(
    client,
    env.DISCORD_INPUT_FORUM_CHANNEL_ID,
    issue.number
  );

  for (const thread of threads) {
    if (thread.archived) {
      console.log(`Unarchiving thread for issue #${issue.number}`);
      await thread.setArchived(false, `Issue #${issue.number} reopened on GitHub`);
    }
  }

  console.log(`Unarchived ${threads.length} thread(s)`);
}

async function handleIssueLabeled(client, payload) {
  const issue = payload.event.issue;
  const label = payload.event.label;

  if (isSyncLabel(label.name)) {
    return;
  }

  const threads = await findThreadsForIssue(
    client,
    env.DISCORD_INPUT_FORUM_CHANNEL_ID,
    issue.number
  );

  if (threads.length === 0) {
    console.log(`No synced threads for issue #${issue.number}`);
    return;
  }

  const forum = await client.channels.fetch(env.DISCORD_INPUT_FORUM_CHANNEL_ID);
  const tag = await getOrCreateForumTag(forum, label.name);

  if (!tag) {
    return;
  }

  for (const thread of threads) {
    const currentTags = thread.appliedTags || [];
    if (!currentTags.includes(tag.id)) {
      // Discord limit: 5 tags per thread
      if (currentTags.length >= 5) {
        console.log(`Thread at 5 tag limit, cannot add "${label.name}"`);
        continue;
      }
      console.log(`Adding tag "${label.name}" to thread`);
      await thread.setAppliedTags([...currentTags, tag.id]);
    }
  }
}

async function handleIssueUnlabeled(client, payload) {
  const issue = payload.event.issue;
  const label = payload.event.label;

  if (isSyncLabel(label.name)) {
    return;
  }

  const threads = await findThreadsForIssue(
    client,
    env.DISCORD_INPUT_FORUM_CHANNEL_ID,
    issue.number
  );

  if (threads.length === 0) {
    return;
  }

  const forum = await client.channels.fetch(env.DISCORD_INPUT_FORUM_CHANNEL_ID);
  const tag = forum.availableTags.find(
    (t) => t.name.toLowerCase() === label.name.toLowerCase()
  );

  if (!tag) {
    return;
  }

  for (const thread of threads) {
    const currentTags = thread.appliedTags || [];
    if (currentTags.includes(tag.id)) {
      console.log(`Removing tag "${label.name}" from thread`);
      await thread.setAppliedTags(currentTags.filter((id) => id !== tag.id));
    }
  }
}

async function handleIssueMilestoned(client, payload) {
  const issue = payload.event.issue;
  const milestone = payload.event.milestone;

  const threads = await findThreadsForIssue(
    client,
    env.DISCORD_INPUT_FORUM_CHANNEL_ID,
    issue.number
  );

  if (threads.length === 0) {
    return;
  }

  const embed = {
    embeds: [
      {
        description: `Added to milestone **[${milestone.title}](${milestone.html_url})**`,
        color: 0x238636,
        footer: {
          text: milestone.description || `${milestone.open_issues} open · ${milestone.closed_issues} closed`,
        },
      },
    ],
  };

  for (const thread of threads) {
    console.log(`Notifying milestone "${milestone.title}" on thread`);
    await thread.send(embed);
  }
}

async function handleIssueAssigned(client, payload) {
  const issue = payload.event.issue;
  const assignee = payload.event.assignee;

  const threads = await findThreadsForIssue(
    client,
    env.DISCORD_INPUT_FORUM_CHANNEL_ID,
    issue.number
  );

  if (threads.length === 0) {
    return;
  }

  const embed = {
    embeds: [
      {
        description: `Assigned to **[${assignee.login}](${assignee.html_url})**`,
        color: 0x1f6feb,
        thumbnail: {
          url: assignee.avatar_url,
        },
      },
    ],
  };

  for (const thread of threads) {
    console.log(`Notifying assignee "${assignee.login}" on thread`);
    await thread.send(embed);
  }
}

function process(payload) {
  console.log(`Processing action: ${payload.event.action}`);

  const client = createDiscordClient();

  client.login(env.DISCORD_TOKEN).catch((err) => {
    console.error("Discord login failed:", err);
    client.destroy();
  });

  client.once(Events.ClientReady, async () => {
    try {
      switch (payload.event.action) {
        case "created":
          await handleNewComment(client, payload);
          break;
        case "opened":
          await handleNewIssue(client, payload);
          break;
        case "closed":
          await handleIssueClosed(client, payload);
          break;
        case "reopened":
          await handleIssueReopened(client, payload);
          break;
        case "labeled":
          await handleIssueLabeled(client, payload);
          break;
        case "unlabeled":
          await handleIssueUnlabeled(client, payload);
          break;
        case "milestoned":
          await handleIssueMilestoned(client, payload);
          break;
        case "assigned":
          await handleIssueAssigned(client, payload);
          break;
      }
    } catch (err) {
      console.error("Error processing payload:", err);
    } finally {
      client.destroy();
    }
  });
}

module.exports = { process };
