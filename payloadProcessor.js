const { Events } = require("discord.js");
const { env } = require("process");
const {
  createDiscordClient,
  createSyncEmbed,
  createCommentEmbed,
  processGitHubIssueRefs,
  hasSyncLabel,
  isSyncLabel,
  getRepoOwner,
  getRepoName,
  SYNC_LABEL,
  sleep,
  findThreadsForIssue,
  getOrCreateForumTag,
  setTargetRepo,
} = require("./utils.js");

function isIgnoredComment(comment) {
  return (
    comment.user.login === "Discord-Github-Bridge" ||
    comment.body.includes("** on Discord says]")
  );
}

async function withDiscordClient(fn) {
  const client = createDiscordClient();

  return new Promise((resolve, reject) => {
    client.login(env.DISCORD_TOKEN).catch((err) => {
      console.error("Discord login failed:", err);
      client.destroy();
      reject(err);
    });

    client.once(Events.ClientReady, async () => {
      try {
        await fn(client);
        resolve();
      } catch (err) {
        console.error("Error in Discord handler:", err);
        reject(err);
      } finally {
        client.destroy();
      }
    });
  });
}

async function createDiscordThread(client, issue, octokit) {
  const channel = await client.channels.fetch(env.DISCORD_INPUT_FORUM_CHANNEL_ID);
  const repoName = getRepoName();

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
    },
    repoName
  );

  const tagIds = [];

  // Add repo tag first (just repo name, no org)
  const repoTag = await getOrCreateForumTag(channel, repoName);
  if (repoTag) tagIds.push(repoTag.id);

  // Add label tags
  const labels = (issue.labels || []).filter((l) => !isSyncLabel(l.name));
  for (const label of labels) {
    if (tagIds.length >= 5) break;
    const tag = await getOrCreateForumTag(channel, label.name);
    if (tag && !tagIds.includes(tag.id)) tagIds.push(tag.id);
  }

  const thread = await channel.threads.create({
    name: issue.title,
    message: syncMessage,
    appliedTags: tagIds,
  });

  const starterMessage = await thread.fetchStarterMessage();
  await starterMessage.pin();

  return thread;
}

async function handleIssueComment({ octokit, payload }) {
  const repo = payload.repository.full_name;
  setTargetRepo(repo);
  console.log(`Processing issue_comment from ${repo}`);

  const issue = payload.issue;
  const comment = payload.comment;

  if (isIgnoredComment(comment)) {
    console.log("Ignoring bot comment");
    return;
  }

  await withDiscordClient(async (client) => {
    if (!hasSyncLabel(issue)) {
      await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/labels", {
        owner: getRepoOwner(),
        repo: getRepoName(),
        issue_number: issue.number,
        labels: [SYNC_LABEL],
      });
      console.log("Added sync label");
      await createDiscordThread(client, issue, octokit);
      await sleep(2000);
    }

    const threads = await findThreadsForIssue(
      client,
      env.DISCORD_INPUT_FORUM_CHANNEL_ID,
      issue.number,
      getRepoOwner(),
      getRepoName()
    );

    const processedBody = await processGitHubIssueRefs(
      client,
      env.DISCORD_INPUT_FORUM_CHANNEL_ID,
      comment.body,
      getRepoOwner(),
      getRepoName()
    );

    for (const thread of threads) {
      console.log(`Syncing comment to issue #${issue.number}`);
      await thread.send(createCommentEmbed(comment, processedBody));
    }

    console.log("Comment sync complete");
  });
}

async function handleIssueOpened({ octokit, payload }) {
  const repo = payload.repository.full_name;
  setTargetRepo(repo);
  console.log(`Processing issues.opened from ${repo}`);

  const issue = payload.issue;

  if (hasSyncLabel(issue)) {
    console.log("Issue already synced");
    return;
  }

  await withDiscordClient(async (client) => {
    await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/labels", {
      owner: getRepoOwner(),
      repo: getRepoName(),
      issue_number: issue.number,
      labels: [SYNC_LABEL],
    });

    await createDiscordThread(client, issue, octokit);
  });
}

async function handleIssueClosed({ payload }) {
  const repo = payload.repository.full_name;
  setTargetRepo(repo);
  console.log(`Processing issues.closed from ${repo}`);

  const issue = payload.issue;

  await withDiscordClient(async (client) => {
    const threads = await findThreadsForIssue(
      client,
      env.DISCORD_INPUT_FORUM_CHANNEL_ID,
      issue.number,
      getRepoOwner(),
      getRepoName()
    );

    for (const thread of threads) {
      if (!thread.archived) {
        console.log(`Archiving thread for issue #${issue.number}`);
        await thread.setArchived(true, `Issue #${issue.number} closed on GitHub`);
      }
    }

    console.log(`Archived ${threads.length} thread(s)`);
  });
}

async function handleIssueReopened({ payload }) {
  const repo = payload.repository.full_name;
  setTargetRepo(repo);
  console.log(`Processing issues.reopened from ${repo}`);

  const issue = payload.issue;

  await withDiscordClient(async (client) => {
    const threads = await findThreadsForIssue(
      client,
      env.DISCORD_INPUT_FORUM_CHANNEL_ID,
      issue.number,
      getRepoOwner(),
      getRepoName()
    );

    for (const thread of threads) {
      if (thread.archived) {
        console.log(`Unarchiving thread for issue #${issue.number}`);
        await thread.setArchived(false, `Issue #${issue.number} reopened on GitHub`);
      }
    }

    console.log(`Unarchived ${threads.length} thread(s)`);
  });
}

async function handleIssueLabeled({ payload }) {
  const repo = payload.repository.full_name;
  setTargetRepo(repo);
  console.log(`Processing issues.labeled from ${repo}`);

  const issue = payload.issue;
  const label = payload.label;
  const repoName = getRepoName();

  // Skip sync label and repo name tags
  if (isSyncLabel(label.name) || label.name === repoName) {
    return;
  }

  await withDiscordClient(async (client) => {
    const threads = await findThreadsForIssue(
      client,
      env.DISCORD_INPUT_FORUM_CHANNEL_ID,
      issue.number,
      getRepoOwner(),
      getRepoName()
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
        if (currentTags.length >= 5) {
          console.log(`Thread at 5 tag limit, cannot add "${label.name}"`);
          continue;
        }
        console.log(`Adding tag "${label.name}" to thread`);
        await thread.setAppliedTags([...currentTags, tag.id]);
      }
    }
  });
}

async function handleIssueUnlabeled({ payload }) {
  const repo = payload.repository.full_name;
  setTargetRepo(repo);
  console.log(`Processing issues.unlabeled from ${repo}`);

  const issue = payload.issue;
  const label = payload.label;
  const repoName = getRepoName();

  // Skip sync label and repo name tags
  if (isSyncLabel(label.name) || label.name === repoName) {
    return;
  }

  await withDiscordClient(async (client) => {
    const threads = await findThreadsForIssue(
      client,
      env.DISCORD_INPUT_FORUM_CHANNEL_ID,
      issue.number,
      getRepoOwner(),
      getRepoName()
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
  });
}

async function handleIssueMilestoned({ payload }) {
  const repo = payload.repository.full_name;
  setTargetRepo(repo);
  console.log(`Processing issues.milestoned from ${repo}`);

  const issue = payload.issue;
  const milestone = payload.milestone;

  await withDiscordClient(async (client) => {
    const threads = await findThreadsForIssue(
      client,
      env.DISCORD_INPUT_FORUM_CHANNEL_ID,
      issue.number,
      getRepoOwner(),
      getRepoName()
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
  });
}

async function handleIssueAssigned({ payload }) {
  const repo = payload.repository.full_name;
  setTargetRepo(repo);
  console.log(`Processing issues.assigned from ${repo}`);

  const issue = payload.issue;
  const assignee = payload.assignee;

  await withDiscordClient(async (client) => {
    const threads = await findThreadsForIssue(
      client,
      env.DISCORD_INPUT_FORUM_CHANNEL_ID,
      issue.number,
      getRepoOwner(),
      getRepoName()
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
  });
}

module.exports = {
  handleIssueComment,
  handleIssueOpened,
  handleIssueClosed,
  handleIssueReopened,
  handleIssueLabeled,
  handleIssueUnlabeled,
  handleIssueMilestoned,
  handleIssueAssigned,
};
