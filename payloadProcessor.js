const { Events } = require("discord.js");
const { env } = require("process");
const {
  createDiscordClient,
  createSyncEmbed,
  createCommentEmbed,
  processGitHubIssueRefs,
  hasSyncLabel,
  isSyncLabel,
  isClosedTag,
  SYNC_LABEL,
  CLOSED_TAG_NAME,
  sleep,
  findThreadsForIssue,
  getOrCreateForumTag,
  getOrCreateClosedForumTag,
  REPO_TAG_EMOJI,
  setThreadCacheEntry,
  logEvent,
  formatError,
} = require("./utils.js");

function getRepoInfo(repository) {
  const fullName = repository?.full_name || "";
  const [ownerFromFull, repoFromFull] = fullName.split("/");
  const owner = repository?.owner?.login || ownerFromFull;
  const repo = repository?.name || repoFromFull;
  if (!owner || !repo) {
    throw new Error("Repository info missing in webhook payload");
  }
  return { owner, repo, fullName: `${owner}/${repo}` };
}

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
      logEvent("error", "discord.login.failed", { error: formatError(err) });
      client.destroy();
      reject(err);
    });

    client.once(Events.ClientReady, async () => {
      client.rest.on("rateLimited", (info) => {
        logEvent("warn", "discord.rate_limited", {
          timeout: info.timeout,
          limit: info.limit,
          method: info.method,
          route: info.route,
          global: info.global,
        });
      });

      try {
        await fn(client);
        resolve();
      } catch (err) {
        logEvent("error", "discord.handler.error", { error: formatError(err) });
        reject(err);
      } finally {
        client.destroy();
      }
    });
  });
}

async function createDiscordThread(client, issue, owner, repoName) {
  const channel = await client.channels.fetch(env.DISCORD_INPUT_FORUM_CHANNEL_ID);

  await getOrCreateClosedForumTag(channel);

  logEvent("info", "discord.thread.create", {
    issueNumber: issue.number,
    repo: `${owner}/${repoName}`,
  });

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
  const repoTag = await getOrCreateForumTag(channel, repoName, REPO_TAG_EMOJI);
  if (repoTag) tagIds.push(repoTag.id);

  // Add label tags
  const labels = (issue.labels || []).filter(
    (l) => !isSyncLabel(l.name) && !isClosedTag({ name: l.name })
  );
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

  await setThreadCacheEntry(owner, repoName, issue.number, {
    threadId: thread.id,
    title: issue.title,
  });

  return thread;
}

function createIssueStatusEmbed(issue, action, actor) {
  const isClosed = action === "closed";
  const title = isClosed ? "Issue closed" : "Issue reopened";
  const color = isClosed ? 0xda3633 : 0x238636;
  const actorLine = actor ? `${isClosed ? "Closed" : "Reopened"} by **${actor}**` : "Updated on GitHub";
  return {
    embeds: [
      {
        title,
        description: `[${issue.title} (#${issue.number})](${issue.html_url})\n${actorLine}`,
        color,
      },
    ],
  };
}

async function handleIssueComment({ octokit, payload, installationId }) {
  const { owner, repo, fullName } = getRepoInfo(payload.repository);
  const issue = payload.issue;
  const comment = payload.comment;

  logEvent("info", "github.issue_comment.received", {
    repo: fullName,
    issueNumber: issue.number,
    commentId: comment.id,
    installationId,
  });

  if (!octokit) {
    logEvent("error", "github.octokit.missing", {
      repo: fullName,
      installationId,
      event: "issue_comment",
    });
    return;
  }

  if (isIgnoredComment(comment)) {
    logEvent("info", "github.issue_comment.ignored", {
      repo: fullName,
      issueNumber: issue.number,
      commentId: comment.id,
    });
    return;
  }

  await withDiscordClient(async (client) => {
    if (!hasSyncLabel(issue)) {
      await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/labels", {
        owner,
        repo,
        issue_number: issue.number,
        labels: [SYNC_LABEL],
      });
      logEvent("info", "github.issue.label.added", {
        repo: fullName,
        issueNumber: issue.number,
        label: SYNC_LABEL,
        installationId,
      });
      await createDiscordThread(client, issue, owner, repo);
      await sleep(2000);
    }

    logEvent("info", "discord.comment.sync.start", {
      repo: fullName,
      issueNumber: issue.number,
      installationId,
    });

    const threads = await findThreadsForIssue(
      client,
      env.DISCORD_INPUT_FORUM_CHANNEL_ID,
      issue.number,
      owner,
      repo,
      issue.title
    );

    logEvent("info", "discord.comment.sync.threads", {
      repo: fullName,
      issueNumber: issue.number,
      threadCount: threads.length,
      installationId,
    });

    if (threads.length === 0) {
      logEvent("warn", "discord.comment.sync.no_threads", {
        repo: fullName,
        issueNumber: issue.number,
        installationId,
      });
      return;
    }

    const processedBody = await processGitHubIssueRefs(
      client,
      env.DISCORD_INPUT_FORUM_CHANNEL_ID,
      comment.body,
      owner,
      repo,
      issue.title
    );

    logEvent("info", "discord.comment.sync.body", {
      repo: fullName,
      issueNumber: issue.number,
      length: processedBody.length,
      installationId,
    });

    for (const thread of threads) {
      logEvent("info", "discord.comment.sync", {
        repo: fullName,
        issueNumber: issue.number,
        threadId: thread.id,
        installationId,
      });
      await thread.send(createCommentEmbed(comment, processedBody));
    }

    logEvent("info", "discord.comment.sync.complete", {
      repo: fullName,
      issueNumber: issue.number,
      threadCount: threads.length,
      installationId,
    });
  });
}

async function handleIssueOpened({ octokit, payload, installationId }) {
  const { owner, repo, fullName } = getRepoInfo(payload.repository);
  const issue = payload.issue;

  logEvent("info", "github.issue.opened", {
    repo: fullName,
    issueNumber: issue.number,
    installationId,
  });

  if (!octokit) {
    logEvent("error", "github.octokit.missing", {
      repo: fullName,
      installationId,
      event: "issues.opened",
    });
    return;
  }

  if (hasSyncLabel(issue)) {
    logEvent("info", "github.issue.already_synced", {
      repo: fullName,
      issueNumber: issue.number,
      installationId,
    });
    return;
  }

  await withDiscordClient(async (client) => {
    await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/labels", {
      owner,
      repo,
      issue_number: issue.number,
      labels: [SYNC_LABEL],
    });
    logEvent("info", "github.issue.label.added", {
      repo: fullName,
      issueNumber: issue.number,
      label: SYNC_LABEL,
      installationId,
    });

    await createDiscordThread(client, issue, owner, repo);
  });
}

async function handleIssueClosed({ payload, installationId }) {
  const { owner, repo, fullName } = getRepoInfo(payload.repository);
  const issue = payload.issue;

  logEvent("info", "github.issue.closed", {
    repo: fullName,
    issueNumber: issue.number,
    installationId,
  });

  await withDiscordClient(async (client) => {
    const threads = await findThreadsForIssue(
      client,
      env.DISCORD_INPUT_FORUM_CHANNEL_ID,
      issue.number,
      owner,
      repo,
      issue.title
    );

    const forum = await client.channels.fetch(env.DISCORD_INPUT_FORUM_CHANNEL_ID);
    const closedTag = await getOrCreateClosedForumTag(forum);
    const closeEmbed = createIssueStatusEmbed(issue, "closed", payload.sender?.login);

    for (const thread of threads) {
      logEvent("info", "discord.thread.close_notice", {
        repo: fullName,
        issueNumber: issue.number,
        threadId: thread.id,
        installationId,
      });
      await thread.send(closeEmbed);

      if (closedTag) {
        const currentTags = thread.appliedTags || [];
        if (!currentTags.includes(closedTag.id)) {
          if (currentTags.length >= 5) {
            logEvent("warn", "discord.thread.tag.limit", {
              repo: fullName,
              issueNumber: issue.number,
              threadId: thread.id,
              label: CLOSED_TAG_NAME,
              installationId,
            });
          } else {
            await thread.setAppliedTags([...currentTags, closedTag.id]);
            logEvent("info", "discord.thread.tag.add", {
              repo: fullName,
              issueNumber: issue.number,
              threadId: thread.id,
              label: CLOSED_TAG_NAME,
              installationId,
            });
          }
        }
      }
    }

    logEvent("info", "discord.thread.close.complete", {
      repo: fullName,
      issueNumber: issue.number,
      threadCount: threads.length,
      installationId,
    });
  });
}

async function handleIssueReopened({ payload, installationId }) {
  const { owner, repo, fullName } = getRepoInfo(payload.repository);
  const issue = payload.issue;

  logEvent("info", "github.issue.reopened", {
    repo: fullName,
    issueNumber: issue.number,
    installationId,
  });

  await withDiscordClient(async (client) => {
    const threads = await findThreadsForIssue(
      client,
      env.DISCORD_INPUT_FORUM_CHANNEL_ID,
      issue.number,
      owner,
      repo,
      issue.title
    );

    const forum = await client.channels.fetch(env.DISCORD_INPUT_FORUM_CHANNEL_ID);
    const closedTag = await getOrCreateClosedForumTag(forum);
    const reopenEmbed = createIssueStatusEmbed(issue, "reopened", payload.sender?.login);

    for (const thread of threads) {
      logEvent("info", "discord.thread.reopen_notice", {
        repo: fullName,
        issueNumber: issue.number,
        threadId: thread.id,
        installationId,
      });
      await thread.send(reopenEmbed);

      if (closedTag) {
        const currentTags = thread.appliedTags || [];
        if (currentTags.includes(closedTag.id)) {
          await thread.setAppliedTags(currentTags.filter((id) => id !== closedTag.id));
          logEvent("info", "discord.thread.tag.remove", {
            repo: fullName,
            issueNumber: issue.number,
            threadId: thread.id,
            label: CLOSED_TAG_NAME,
            installationId,
          });
        }
      }
    }

    logEvent("info", "discord.thread.reopen.complete", {
      repo: fullName,
      issueNumber: issue.number,
      threadCount: threads.length,
      installationId,
    });
  });
}

async function handleIssueEdited({ payload, installationId }) {
  const { owner, repo, fullName } = getRepoInfo(payload.repository);
  const issue = payload.issue;
  const titleChange = payload.changes?.title;

  if (!titleChange || !titleChange.from) {
    return;
  }

  logEvent("info", "github.issue.edited", {
    repo: fullName,
    issueNumber: issue.number,
    installationId,
  });

  await withDiscordClient(async (client) => {
    const threads = await findThreadsForIssue(
      client,
      env.DISCORD_INPUT_FORUM_CHANNEL_ID,
      issue.number,
      owner,
      repo,
      issue.title
    );

    for (const thread of threads) {
      if (thread.name !== issue.title) {
        logEvent("info", "discord.thread.rename", {
          repo: fullName,
          issueNumber: issue.number,
          threadId: thread.id,
          oldTitle: thread.name,
          newTitle: issue.title,
          installationId,
        });
        await thread.setName(issue.title);
        await setThreadCacheEntry(owner, repo, issue.number, {
          threadId: thread.id,
          title: issue.title,
        });
      }
    }
  });
}

async function handleIssueLabeled({ payload, installationId }) {
  const { owner, repo, fullName } = getRepoInfo(payload.repository);
  const issue = payload.issue;
  const label = payload.label;

  logEvent("info", "github.issue.labeled", {
    repo: fullName,
    issueNumber: issue.number,
    label: label.name,
    installationId,
  });

  // Skip sync label, repo name tags, and closed tag
  if (isSyncLabel(label.name) || label.name === repo || isClosedTag({ name: label.name })) {
    return;
  }

  await withDiscordClient(async (client) => {
    const threads = await findThreadsForIssue(
      client,
      env.DISCORD_INPUT_FORUM_CHANNEL_ID,
      issue.number,
      owner,
      repo,
      issue.title
    );

    if (threads.length === 0) {
      logEvent("info", "discord.thread.missing", {
        repo: fullName,
        issueNumber: issue.number,
        installationId,
      });
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
          logEvent("warn", "discord.thread.tag.limit", {
            repo: fullName,
            issueNumber: issue.number,
            threadId: thread.id,
            label: label.name,
            installationId,
          });
          continue;
        }
        logEvent("info", "discord.thread.tag.add", {
          repo: fullName,
          issueNumber: issue.number,
          threadId: thread.id,
          label: label.name,
          installationId,
        });
        await thread.setAppliedTags([...currentTags, tag.id]);
      }
    }
  });
}

async function handleIssueUnlabeled({ payload, installationId }) {
  const { owner, repo, fullName } = getRepoInfo(payload.repository);
  const issue = payload.issue;
  const label = payload.label;

  logEvent("info", "github.issue.unlabeled", {
    repo: fullName,
    issueNumber: issue.number,
    label: label.name,
    installationId,
  });

  // Skip sync label, repo name tags, and closed tag
  if (isSyncLabel(label.name) || label.name === repo || isClosedTag({ name: label.name })) {
    return;
  }

  await withDiscordClient(async (client) => {
    const threads = await findThreadsForIssue(
      client,
      env.DISCORD_INPUT_FORUM_CHANNEL_ID,
      issue.number,
      owner,
      repo,
      issue.title
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
        logEvent("info", "discord.thread.tag.remove", {
          repo: fullName,
          issueNumber: issue.number,
          threadId: thread.id,
          label: label.name,
          installationId,
        });
        await thread.setAppliedTags(currentTags.filter((id) => id !== tag.id));
      }
    }
  });
}

async function handleIssueMilestoned({ payload, installationId }) {
  const { owner, repo, fullName } = getRepoInfo(payload.repository);
  const issue = payload.issue;
  const milestone = payload.milestone;

  logEvent("info", "github.issue.milestoned", {
    repo: fullName,
    issueNumber: issue.number,
    milestone: milestone.title,
    installationId,
  });

  await withDiscordClient(async (client) => {
    const threads = await findThreadsForIssue(
      client,
      env.DISCORD_INPUT_FORUM_CHANNEL_ID,
      issue.number,
      owner,
      repo,
      issue.title
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
      logEvent("info", "discord.thread.milestoned", {
        repo: fullName,
        issueNumber: issue.number,
        threadId: thread.id,
        milestone: milestone.title,
        installationId,
      });
      await thread.send(embed);
    }
  });
}

async function handleIssueAssigned({ payload, installationId }) {
  const { owner, repo, fullName } = getRepoInfo(payload.repository);
  const issue = payload.issue;
  const assignee = payload.assignee;

  logEvent("info", "github.issue.assigned", {
    repo: fullName,
    issueNumber: issue.number,
    assignee: assignee.login,
    installationId,
  });

  await withDiscordClient(async (client) => {
    const threads = await findThreadsForIssue(
      client,
      env.DISCORD_INPUT_FORUM_CHANNEL_ID,
      issue.number,
      owner,
      repo,
      issue.title
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
      logEvent("info", "discord.thread.assigned", {
        repo: fullName,
        issueNumber: issue.number,
        threadId: thread.id,
        assignee: assignee.login,
        installationId,
      });
      await thread.send(embed);
    }
  });
}

module.exports = {
  handleIssueComment,
  handleIssueOpened,
  handleIssueClosed,
  handleIssueReopened,
  handleIssueEdited,
  handleIssueLabeled,
  handleIssueUnlabeled,
  handleIssueMilestoned,
  handleIssueAssigned,
};
