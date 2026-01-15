const { Events } = require("discord.js");
const { env } = require("process");
const { setGlobalDispatcher, Agent, Pool } = require("undici");
const {
  createDiscordClient,
  isForumThread,
  processMessageContent,
  getSyncedIssueInfo,
  formatDiscordAuthorComment,
  createSyncEmbed,
  getDefaultRepo,
  SYNC_LABEL,
  REPO_TAG_EMOJI,
  isSyncLabel,
  sleep,
  getOrCreateGitHubLabel,
  getOrCreateForumTag,
  logEvent,
  formatError,
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

const INSTALLATION_REPO_TTL_MS = 5 * 60 * 1000;
const installationRepoCache = new Map();

function getTagEmojiName(tag) {
  if (!tag) return null;
  if (typeof tag.emoji === "string") return tag.emoji;
  return tag.emoji?.name || null;
}

function isRepoSelectorTag(tag) {
  return getTagEmojiName(tag) === REPO_TAG_EMOJI;
}

async function listInstallationRepos(octokit) {
  const repos = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const { data } = await octokit.request("GET /installation/repositories", {
      per_page: perPage,
      page,
    });
    const pageRepos = data.repositories || [];
    repos.push(...pageRepos);
    if (pageRepos.length < perPage) break;
    if (data.total_count && repos.length >= data.total_count) break;
    page += 1;
  }

  return repos;
}

async function getInstallationRepoMap(octokit, installationId) {
  if (!installationId) {
    return { repoMap: new Map(), repoCount: 0, source: "none" };
  }

  const cached = installationRepoCache.get(installationId);
  if (cached && cached.expiresAt > Date.now()) {
    return { repoMap: cached.repoMap, repoCount: cached.repoCount, source: "cache" };
  }

  try {
    const repos = await listInstallationRepos(octokit);
    const repoMap = new Map();
    for (const repo of repos) {
      const key = repo.name.toLowerCase();
      if (!repoMap.has(key)) {
        repoMap.set(key, repo);
      }
    }
    installationRepoCache.set(installationId, {
      repoMap,
      repoCount: repos.length,
      expiresAt: Date.now() + INSTALLATION_REPO_TTL_MS,
    });
    logEvent("info", "github.installation.repos.refresh", {
      installationId,
      repoCount: repos.length,
    });
    return { repoMap, repoCount: repos.length, source: "refresh" };
  } catch (err) {
    logEvent("error", "github.installation.repos.error", {
      installationId,
      error: formatError(err),
    });
    return { repoMap: new Map(), repoCount: 0, source: "error" };
  }
}

function resolveRepoFromTags(appliedTags, availableTags, repoMap) {
  for (const tagId of appliedTags) {
    const tag = availableTags.find((t) => t.id === tagId);
    if (!tag || !isRepoSelectorTag(tag)) continue;
    const repo = repoMap.get(tag.name.toLowerCase());
    if (!repo) continue;
    const fullName = repo.full_name || "";
    const owner = repo.owner?.login || fullName.split("/")[0];
    if (!owner) continue;
    return { owner, repo: repo.name, tagName: tag.name };
  }
  return null;
}

// Initialize GitHub App and register webhook handlers
async function setupWebhooks() {
  const webhooks = await getWebhooks();

  // Wrap handlers to inject octokit from installation ID
  const wrapHandler = (handler, eventName) => async (context) => {
    const installationId = context.payload.installation?.id || null;
    if (installationId) {
      lastInstallationId = installationId;
    }

    logEvent("info", "github.webhook.received", {
      event: eventName,
      repo: context.payload.repository?.full_name,
      installationId,
    });

    if (!installationId) {
      logEvent("warn", "github.webhook.missing_installation", {
        event: eventName,
        repo: context.payload.repository?.full_name,
      });
    }

    const octokit = installationId ? await getInstallationOctokit(installationId) : null;
    await handler({ octokit, payload: context.payload, installationId, event: eventName });
  };

  // Issue events
  webhooks.on("issues.opened", wrapHandler(handleIssueOpened, "issues.opened"));
  webhooks.on("issues.closed", wrapHandler(handleIssueClosed, "issues.closed"));
  webhooks.on("issues.reopened", wrapHandler(handleIssueReopened, "issues.reopened"));
  webhooks.on("issues.labeled", wrapHandler(handleIssueLabeled, "issues.labeled"));
  webhooks.on("issues.unlabeled", wrapHandler(handleIssueUnlabeled, "issues.unlabeled"));
  webhooks.on("issues.milestoned", wrapHandler(handleIssueMilestoned, "issues.milestoned"));
  webhooks.on("issues.assigned", wrapHandler(handleIssueAssigned, "issues.assigned"));

  // Comment events
  webhooks.on("issue_comment.created", wrapHandler(handleIssueComment, "issue_comment.created"));

  // Error handling
  webhooks.onError((error) => {
    logEvent("error", "github.webhook.error", { error: formatError(error) });
  });

  // Use the middleware
  const webhookMiddleware = await getWebhookMiddleware();
  expressApp.use(webhookMiddleware);

  logEvent("info", "github.webhook.registered");
}

async function startServer() {
  await setupWebhooks();
  expressApp.listen(PORT, () => {
    logEvent("info", "server.start", { port: PORT });
  });
}

startServer().catch((err) => {
  logEvent("error", "server.start.error", { error: formatError(err) });
  process.exit(1);
});

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

    logEvent("info", "discord.message.received", {
      threadId: message.channel.id,
      messageId: message.id,
      author: message.author.username,
      installationId: lastInstallationId,
    });

    const octokit = await getOctokit();
    const defaultRepo = getDefaultRepo();
    const newContent = processMessageContent(message);

    // Add repo tags for any synced repos that aren't tagged yet
    const forum = await message.client.channels.fetch(env.DISCORD_INPUT_FORUM_CHANNEL_ID);
    const thread = message.channel;
    const currentTags = thread.appliedTags || [];
    const reposToTag = [...new Set(syncedIssues.map((i) => i.repo).filter(Boolean))];

    for (const repoName of reposToTag) {
      const repoTag = await getOrCreateForumTag(forum, repoName, REPO_TAG_EMOJI);
      if (repoTag && !currentTags.includes(repoTag.id) && currentTags.length < 5) {
        logEvent("info", "discord.thread.repo_tag.add", {
          threadId: thread.id,
          repo: repoName,
          installationId: lastInstallationId,
        });
        currentTags.push(repoTag.id);
        await thread.setAppliedTags(currentTags);
      }
    }

    for (const { number: issueNumber, owner: issueOwner, repo: repoName } of syncedIssues) {
      // Use owner/repo from pinned message, fall back to env
      const owner = issueOwner || defaultRepo.owner;
      const repo = repoName || defaultRepo.repo;

      const { data: issue } = await octokit.request("GET /repos/{owner}/{repo}/issues/{issue_number}", {
        owner,
        repo,
        issue_number: issueNumber,
      });

      logEvent("info", "github.issue.comments.count", {
        repo: `${owner}/${repo}`,
        issueNumber,
        comments: issue.comments,
        installationId: lastInstallationId,
      });

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
      logEvent("info", "github.issue.comment.last_author", {
        repo: `${owner}/${repo}`,
        issueNumber,
        lastAuthor: lastCommentAuthor,
        currentAuthor: message.author.username,
        installationId: lastInstallationId,
      });

      if (lastComment && lastCommentAuthor === message.author.username) {
        logEvent("info", "github.issue.comment.append", {
          repo: `${owner}/${repo}`,
          issueNumber,
          commentId: lastComment.id,
          author: message.author.username,
          installationId: lastInstallationId,
        });
        await octokit.request("PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}", {
          owner,
          repo,
          comment_id: lastComment.id,
          body: `${lastComment.body}\n${newContent}`,
        });
      } else {
        logEvent("info", "github.issue.comment.create", {
          repo: `${owner}/${repo}`,
          issueNumber,
          author: message.author.username,
          installationId: lastInstallationId,
        });
        await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
          owner,
          repo,
          issue_number: issueNumber,
          body: formatDiscordAuthorComment(message.author, message.url, newContent),
        });
      }
    }
  } catch (err) {
    logEvent("error", "discord.message.error", {
      error: formatError(err),
      installationId: lastInstallationId,
    });
  }
}

async function handleThreadUpdate(oldThread, newThread) {
  try {
    if (!isForumThread(newThread)) return;

    const syncedIssues = await getSyncedIssueInfo(newThread);
    if (syncedIssues.length === 0) return;

    logEvent("info", "discord.thread.update", {
      threadId: newThread.id,
      archived: newThread.archived,
      installationId: lastInstallationId,
    });

    const octokit = await getOctokit();
    const defaultRepo = getDefaultRepo();

    // Handle archive state change
    if (oldThread.archived !== newThread.archived) {
      const state = newThread.archived ? "closed" : "open";
      for (const { number: issueNumber, owner: issueOwner, repo: repoName } of syncedIssues) {
        const owner = issueOwner || defaultRepo.owner;
        const repo = repoName || defaultRepo.repo;

        logEvent("info", "github.issue.state.update", {
          repo: `${owner}/${repo}`,
          issueNumber,
          state,
          installationId: lastInstallationId,
        });
        await octokit.request("PATCH /repos/{owner}/{repo}/issues/{issue_number}", {
          owner,
          repo,
          issue_number: issueNumber,
          state,
        });
      }
    }

    // Handle tag changes (sync to GitHub labels, skip repo tags)
    const oldTags = oldThread.appliedTags || [];
    const newTags = newThread.appliedTags || [];

    if (JSON.stringify([...oldTags].sort()) === JSON.stringify([...newTags].sort())) return;

    const forum = await newThread.client.channels.fetch(env.DISCORD_INPUT_FORUM_CHANNEL_ID);
    const tagMap = new Map(forum.availableTags.map((t) => [t.id, t]));

    const addedTagIds = newTags.filter((id) => !oldTags.includes(id));
    const removedTagIds = oldTags.filter((id) => !newTags.includes(id));

    const syncedRepoNames = new Set(
      syncedIssues
        .map((i) => i.repo)
        .filter(Boolean)
        .map((name) => name.toLowerCase())
    );
    if (syncedRepoNames.size === 0) {
      syncedRepoNames.add(defaultRepo.repo.toLowerCase());
    }

    const isRepoNameTag = (name) => syncedRepoNames.has(name.toLowerCase());

    for (const { number: issueNumber, owner: issueOwner, repo: repoName } of syncedIssues) {
      const owner = issueOwner || defaultRepo.owner;
      const repo = repoName || defaultRepo.repo;

      for (const tagId of addedTagIds) {
        const tag = tagMap.get(tagId);
        const tagName = tag?.name;
        if (!tagName || isSyncLabel(tagName) || isRepoSelectorTag(tag) || isRepoNameTag(tagName)) continue;

        logEvent("info", "github.issue.label.add", {
          repo: `${owner}/${repo}`,
          issueNumber,
          label: tagName,
          installationId: lastInstallationId,
        });
        await getOrCreateGitHubLabel(octokit, owner, repo, tagName);
        await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/labels", {
          owner,
          repo,
          issue_number: issueNumber,
          labels: [tagName],
        });
      }

      for (const tagId of removedTagIds) {
        const tag = tagMap.get(tagId);
        const tagName = tag?.name;
        if (!tagName || isSyncLabel(tagName) || isRepoSelectorTag(tag) || isRepoNameTag(tagName)) continue;

        logEvent("info", "github.issue.label.remove", {
          repo: `${owner}/${repo}`,
          issueNumber,
          label: tagName,
          installationId: lastInstallationId,
        });
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
    logEvent("error", "discord.thread.update.error", {
      error: formatError(err),
      installationId: lastInstallationId,
    });
  }
}

async function handleNewThread(thread) {
  try {
    logEvent("info", "discord.thread.created", {
      threadId: thread.id,
      installationId: lastInstallationId,
    });
    await sleep(500);

    const message = await thread.fetchStarterMessage();
    if (!message || !isForumThread(message.channel)) return;
    if (message.author.bot) return;
    if (message.content.startsWith("`synced with issue #")) return;
    if (message.content.startsWith("`Synced with issue #")) return;

    logEvent("info", "discord.thread.process", {
      threadId: thread.id,
      messageId: message.id,
      installationId: lastInstallationId,
    });

    const octokit = await getOctokit();
    const defaultRepo = getDefaultRepo();
    let repoName = defaultRepo.repo;
    let repoOwner = defaultRepo.owner;

    const appliedTags = thread.appliedTags || [];
    const forum = await thread.client.channels.fetch(env.DISCORD_INPUT_FORUM_CHANNEL_ID);

    const { repoMap, repoCount } = await getInstallationRepoMap(octokit, lastInstallationId);
    const repoFromTag = resolveRepoFromTags(appliedTags, forum.availableTags, repoMap);

    let repoSource = "default";
    let repoTagName = null;

    if (repoFromTag) {
      repoName = repoFromTag.repo;
      repoOwner = repoFromTag.owner;
      repoSource = "tag";
      repoTagName = repoFromTag.tagName;
    }

    logEvent("info", "discord.thread.repo.select", {
      threadId: thread.id,
      repo: `${repoOwner}/${repoName}`,
      source: repoSource,
      tagName: repoTagName,
      repoCount,
      installationId: lastInstallationId,
    });

    const tagNames = appliedTags
      .map((id) => forum.availableTags.find((t) => t.id === id))
      .filter(Boolean)
      .filter((tag) => !isRepoSelectorTag(tag))
      .map((tag) => tag.name)
      .filter((name) => name && !isSyncLabel(name))
      .filter((name) => name.toLowerCase() !== repoName.toLowerCase());

    const uniqueTagNames = [...new Set(tagNames)];

    await getOrCreateGitHubLabel(octokit, repoOwner, repoName, SYNC_LABEL);
    for (const tagName of uniqueTagNames) {
      await getOrCreateGitHubLabel(octokit, repoOwner, repoName, tagName);
    }

    const { data: issue } = await octokit.request("POST /repos/{owner}/{repo}/issues", {
      owner: repoOwner,
      repo: repoName,
      title: message.channel.name,
      body: formatDiscordAuthorComment(
        message.author,
        message.url,
        processMessageContent(message)
      ),
      labels: [SYNC_LABEL, ...uniqueTagNames],
    });

    logEvent("info", "github.issue.created", {
      repo: `${repoOwner}/${repoName}`,
      issueNumber: issue.number,
      threadId: thread.id,
      installationId: lastInstallationId,
    });

    // Add repo tag to thread
    const repoTag = await getOrCreateForumTag(forum, repoName, REPO_TAG_EMOJI);
    if (repoTag && !appliedTags.includes(repoTag.id)) {
      const newTags = [repoTag.id, ...appliedTags].slice(0, 5);
      await thread.setAppliedTags(newTags);
      logEvent("info", "discord.thread.repo_tag.add", {
        threadId: thread.id,
        repo: repoName,
        installationId: lastInstallationId,
      });
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
    logEvent("info", "discord.thread.synced", {
      threadId: thread.id,
      repo: `${repoOwner}/${repoName}`,
      issueNumber: issue.number,
      installationId: lastInstallationId,
    });
  } catch (err) {
    logEvent("error", "discord.thread.create.error", {
      error: formatError(err),
      threadId: thread.id,
      installationId: lastInstallationId,
    });
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
    logEvent("error", "discord.login.failed", { error: formatError(err) });
    process.exit(1);
  });
}

module.exports = { start };
