const { Client, GatewayIntentBits } = require("discord.js");
const { env } = require("process");
const fs = require("fs/promises");
const path = require("path");

const DISCORD_INTENTS = [
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.DirectMessages,
  GatewayIntentBits.Guilds,
  GatewayIntentBits.MessageContent,
];

const SYNC_LABEL = "🔵-synced";
const REPO_TAG_EMOJI = env.REPO_TAG_EMOJI || "🧭";
const CLOSED_TAG_NAME = env.CLOSED_TAG_NAME || "closed";
const CLOSED_TAG_EMOJI = env.CLOSED_TAG_EMOJI || "✅";
const CLOSED_TAG_LEGACY_NAME = "✅closed";
const THREAD_CACHE_PATH = env.THREAD_CACHE_PATH || path.join(process.cwd(), "thread-cache.json");
const THREAD_CACHE_SAVE_DELAY_MS = 2000;

function logEvent(level, event, meta = {}) {
  const payload = { time: new Date().toISOString(), level, event, ...meta };
  const output = JSON.stringify(payload);
  if (level === "error") {
    console.error(output);
  } else if (level === "warn") {
    console.warn(output);
  } else {
    console.log(output);
  }
}

function formatError(err) {
  if (!err) return null;
  return {
    name: err.name,
    message: err.message,
    status: err.status,
    stack: err.stack,
    requestUrl: err.request?.url,
    responseStatus: err.response?.status,
  };
}

function getTagEmojiName(tag) {
  if (!tag) return null;
  if (typeof tag.emoji === "string") return tag.emoji;
  return tag.emoji?.name || null;
}

function isRepoSelectorTag(tag) {
  return getTagEmojiName(tag) === REPO_TAG_EMOJI;
}

function isClosedTagName(name) {
  if (!name) return false;
  const normalized = name.toLowerCase();
  return (
    normalized === CLOSED_TAG_NAME.toLowerCase() ||
    normalized === CLOSED_TAG_LEGACY_NAME.toLowerCase()
  );
}

function isClosedTag(tag) {
  if (!tag) return false;
  if (getTagEmojiName(tag) === CLOSED_TAG_EMOJI) return true;
  return isClosedTagName(tag.name);
}

function findClosedForumTag(forum) {
  return forum.availableTags.find((tag) => isClosedTag(tag)) || null;
}

async function getOrCreateClosedForumTag(forum) {
  const existing = findClosedForumTag(forum);
  if (existing) {
    const hasLegacyName = existing.name?.toLowerCase() === CLOSED_TAG_LEGACY_NAME.toLowerCase();
    if (!hasLegacyName && getTagEmojiName(existing) !== CLOSED_TAG_EMOJI) {
      await getOrCreateForumTag(forum, existing.name, CLOSED_TAG_EMOJI);
      return findClosedForumTag(await forum.fetch());
    }
    return existing;
  }
  return getOrCreateForumTag(forum, CLOSED_TAG_NAME, CLOSED_TAG_EMOJI);
}

const threadCache = new Map();
let threadCacheLoaded = false;
let threadCacheSaveTimer = null;

function getThreadCacheKey(owner, repo, issueNumber) {
  return `${owner.toLowerCase()}/${repo.toLowerCase()}#${issueNumber}`;
}

async function loadThreadCache() {
  if (threadCacheLoaded) return;
  threadCacheLoaded = true;
  try {
    const raw = await fs.readFile(THREAD_CACHE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const entries = parsed?.entries || parsed;
    if (entries && typeof entries === "object") {
      for (const [key, value] of Object.entries(entries)) {
        if (value && value.threadId) {
          threadCache.set(key, value);
        }
      }
    }
    logEvent("info", "thread_cache.load", { path: THREAD_CACHE_PATH, count: threadCache.size });
  } catch (err) {
    if (err.code !== "ENOENT") {
      logEvent("error", "thread_cache.load.error", {
        path: THREAD_CACHE_PATH,
        error: formatError(err),
      });
    }
  }
}

function scheduleThreadCacheSave() {
  if (threadCacheSaveTimer) return;
  threadCacheSaveTimer = setTimeout(() => {
    threadCacheSaveTimer = null;
    saveThreadCache().catch((err) => {
      logEvent("error", "thread_cache.save.error", {
        path: THREAD_CACHE_PATH,
        error: formatError(err),
      });
    });
  }, THREAD_CACHE_SAVE_DELAY_MS);
}

async function saveThreadCache() {
  const payload = { entries: Object.fromEntries(threadCache) };
  await fs.writeFile(THREAD_CACHE_PATH, JSON.stringify(payload, null, 2));
  logEvent("info", "thread_cache.save", { path: THREAD_CACHE_PATH, count: threadCache.size });
}

async function getThreadCacheEntry(owner, repo, issueNumber) {
  if (!owner || !repo || !issueNumber) return null;
  await loadThreadCache();
  return threadCache.get(getThreadCacheKey(owner, repo, issueNumber)) || null;
}

async function setThreadCacheEntry(owner, repo, issueNumber, entry) {
  if (!owner || !repo || !issueNumber || !entry?.threadId) return;
  await loadThreadCache();
  threadCache.set(getThreadCacheKey(owner, repo, issueNumber), {
    ...entry,
    updatedAt: Date.now(),
  });
  scheduleThreadCacheSave();
}

async function deleteThreadCacheEntry(owner, repo, issueNumber) {
  if (!owner || !repo || !issueNumber) return;
  await loadThreadCache();
  threadCache.delete(getThreadCacheKey(owner, repo, issueNumber));
  scheduleThreadCacheSave();
}

function getTargetRepo() {
  if (!env.TARGET_REPO) {
    throw new Error("TARGET_REPO env var not set");
  }
  return env.TARGET_REPO;
}

function getDefaultRepo() {
  const [owner, repo] = getTargetRepo().split("/");
  if (!owner || !repo) {
    throw new Error("TARGET_REPO must be in owner/repo format");
  }
  return { owner, repo };
}

function getRepoOwner() {
  return getDefaultRepo().owner;
}

function getRepoName() {
  return getDefaultRepo().repo;
}

function getRandomColor(seedString) {
  let hash = 0;
  for (let i = 0; i < seedString.length; i++) {
    hash = seedString.charCodeAt(i) + ((hash << 5) - hash);
  }
  let hex = "0x";
  for (let i = 0; i < 6; i++) {
    const value = (hash >> (i * 4)) & 0xf;
    hex += value.toString(16);
  }
  return hex;
}

function createDiscordClient() {
  return new Client({ intents: DISCORD_INTENTS });
}

function isForumThread(channel) {
  return channel.parentId === env.DISCORD_INPUT_FORUM_CHANNEL_ID;
}

function processMessageContent(message) {
  let content = message.content;
  const mentions = message.mentions;
  const serverId = env.DISCORD_SERVER_ID;

  content = content.replace(/<#(\d+)>/g, (match, id) => {
    const channel = mentions.channels.get(id);
    if (!channel) return match;
    return `[${channel.name}](https://discord.com/channels/${serverId}/${id})`;
  });

  content = content.replace(/<@(\d+)>/g, (match, id) => {
    const user = mentions.users.get(id);
    if (!user) return match;
    return `[${user.username}](${message.url})`;
  });

  content = content.replace(/<@&(\d+)>/g, (match, id) => {
    const role = mentions.roles.get(id);
    if (!role) return match;
    return `[${role.name}](${message.url})`;
  });

  message.attachments.forEach((attachment) => {
    content += `\n![${attachment.name}](${attachment.url})`;
  });

  return content;
}

async function getSyncedIssueInfo(channel) {
  const pinnedResult = await channel.messages.fetchPins();
  const pinnedMessages = (pinnedResult.items || []).map((item) => item.message);
  const issues = [];

  pinnedMessages.forEach((message) => {
    logEvent("info", "discord.pin.read", { channelId: channel.id, content: message.content });

    // Current format: `Synced with issue #N` on [repo-name](https://github.com/owner/repo)
    // Extract issue number and owner/repo from URL
    const currentMatch = message.content.match(/`Synced with issue #(\d+)`.*on \[.+?\]\(https:\/\/github\.com\/([^/]+)\/([^/)]+)/);
    if (currentMatch) {
      logEvent("info", "discord.pin.match.current", {
        channelId: channel.id,
        issueNumber: parseInt(currentMatch[1], 10),
        owner: currentMatch[2],
        repo: currentMatch[3],
      });
      issues.push({
        number: parseInt(currentMatch[1], 10),
        owner: currentMatch[2],
        repo: currentMatch[3],
      });
      return;
    }

    // Old format: `synced with issue #N` (backwards compat)
    // Extract owner/repo from the GitHub issue URL in the message
    const oldMatch = message.content.match(/`synced with issue #(\d+)`/i);
    if (oldMatch) {
      const urlMatch = message.content.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/\d+/);
      logEvent("info", "discord.pin.match.legacy", {
        channelId: channel.id,
        issueNumber: parseInt(oldMatch[1], 10),
        urlMatch,
      });
      issues.push({
        number: parseInt(oldMatch[1], 10),
        owner: urlMatch ? urlMatch[1] : null,
        repo: urlMatch ? urlMatch[2] : null,
      });
    }
  });

  logEvent("info", "discord.pin.synced_issues", {
    channelId: channel.id,
    count: issues.length,
    issues,
  });
  return issues;
}

// Backwards compat wrapper
async function getSyncedIssueNumbers(channel) {
  const issues = await getSyncedIssueInfo(channel);
  return issues.map((i) => i.number);
}

function hasSyncLabel(issue) {
  return issue.labels?.some((label) => label.name === SYNC_LABEL);
}

function formatDiscordAuthorComment(author, messageUrl, content) {
  const avatarUrl = author.avatarURL() || author.defaultAvatarURL;
  return `[<img src="${avatarUrl}" width="15" height="15"/> **${author.username}** on Discord says](${messageUrl})\n${content}`;
}

function createSyncEmbed(issueNumber, title, body, htmlUrl, author, repoName) {
  // Extract owner from issue URL: https://github.com/owner/repo/issues/N
  const urlMatch = htmlUrl.match(/github\.com\/([^/]+)\/([^/]+)/);
  const owner = urlMatch ? urlMatch[1] : '';
  const repoUrl = `https://github.com/${owner}/${repoName}`;

  return {
    content: `\`Synced with issue #${issueNumber}\` on [${repoName}](${repoUrl}) · [follow on github](${htmlUrl})`,
    embeds: [
      {
        title: `#${issueNumber} ${title}`,
        description: body,
        url: htmlUrl,
        color: parseInt(getRandomColor(author.name), 16),
        author: {
          name: author.name,
          icon_url: author.iconUrl,
          url: author.url || htmlUrl,
        },
      },
    ],
  };
}

function createCommentEmbed(comment, processedBody = null) {
  return {
    embeds: [
      {
        description: processedBody || comment.body,
        url: comment.html_url,
        color: parseInt(getRandomColor(comment.user.login), 16),
        author: {
          name: comment.user.login,
          icon_url: comment.user.avatar_url,
          url: comment.user.html_url,
        },
      },
    ],
  };
}

async function processGitHubIssueRefs(client, forumChannelId, content, owner = null, repo = null) {
  const issueRefPattern = /#(\d+)/g;
  const matches = [...content.matchAll(issueRefPattern)];

  if (matches.length === 0) return content;

  const issueToThread = new Map();

  // Find threads for all referenced issues
  for (const match of matches) {
    const issueNumber = parseInt(match[1], 10);
    if (issueToThread.has(issueNumber)) continue;

    const threads = await findThreadsForIssue(client, forumChannelId, issueNumber, owner, repo);
    if (threads.length > 0) {
      issueToThread.set(issueNumber, threads[0].url);
    }
  }

  // Replace issue refs with Discord thread links
  return content.replace(issueRefPattern, (match, issueNum) => {
    const threadUrl = issueToThread.get(parseInt(issueNum, 10));
    return threadUrl ? `[${match}](${threadUrl})` : match;
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isSyncLabel(labelName) {
  return labelName === SYNC_LABEL;
}

async function getOrCreateForumTag(forum, tagName, emoji = null) {
  const existingTag = forum.availableTags.find(
    (t) => t.name.toLowerCase() === tagName.toLowerCase()
  );
  if (existingTag) {
    if (emoji && getTagEmojiName(existingTag) !== emoji) {
      logEvent("info", "discord.forum.tag.emoji.update", {
        forumId: forum.id,
        tagName,
        emoji,
      });
      const updatedTags = forum.availableTags.map((tag) => {
        const tagData = {
          id: tag.id,
          name: tag.name,
          moderated: tag.moderated,
        };
        if (tag.emoji) {
          tagData.emoji = tag.emoji;
        }
        if (tag.id === existingTag.id) {
          tagData.emoji = emoji;
        }
        return tagData;
      });
      await forum.setAvailableTags(updatedTags);
      const updatedForum = await forum.fetch();
      return updatedForum.availableTags.find(
        (t) => t.name.toLowerCase() === tagName.toLowerCase()
      );
    }
    return existingTag;
  }

  // Create new tag (Discord limit: 20 tags per forum)
  if (forum.availableTags.length >= 20) {
    logEvent("warn", "discord.forum.tag.limit", {
      forumId: forum.id,
      tagName,
      limit: 20,
    });
    return null;
  }

  logEvent("info", "discord.forum.tag.create", { forumId: forum.id, tagName, emoji });
  const newTag = { name: tagName };
  if (emoji) {
    newTag.emoji = emoji;
  }
  await forum.setAvailableTags([...forum.availableTags, newTag]);

  // Refetch to get the new tag with ID
  const updatedForum = await forum.fetch();
  return updatedForum.availableTags.find(
    (t) => t.name.toLowerCase() === tagName.toLowerCase()
  );
}

async function getOrCreateGitHubLabel(octokit, owner, repo, labelName) {
  if (!owner || !repo) {
    throw new Error("owner and repo are required to manage labels");
  }

  try {
    await octokit.request("GET /repos/{owner}/{repo}/labels/{name}", {
      owner,
      repo,
      name: labelName,
    });
    return labelName;
  } catch (err) {
    if (err.status === 404) {
      logEvent("info", "github.label.create", { owner, repo, labelName });
      await octokit.request("POST /repos/{owner}/{repo}/labels", {
        owner,
        repo,
        name: labelName,
      });
      return labelName;
    }
    throw err;
  }
}

async function findThreadsForIssue(
  client,
  forumChannelId,
  issueNumber,
  owner = null,
  repo = null,
  issueTitle = null
) {
  const threads = [];
  const forum = await client.channels.fetch(forumChannelId);

  if (owner && repo) {
    const cached = await getThreadCacheEntry(owner, repo, issueNumber);
    if (cached?.threadId) {
      try {
        const cachedThread = await client.channels.fetch(cached.threadId);
        if (cachedThread && cachedThread.parentId === forumChannelId) {
          logEvent("info", "discord.thread.cache.hit", {
            forumId: forumChannelId,
            issueNumber,
            owner,
            repo,
            threadId: cached.threadId,
          });
          return [cachedThread];
        }
        await deleteThreadCacheEntry(owner, repo, issueNumber);
      } catch (err) {
        await deleteThreadCacheEntry(owner, repo, issueNumber);
        logEvent("warn", "discord.thread.cache.invalid", {
          forumId: forumChannelId,
          issueNumber,
          owner,
          repo,
          threadId: cached.threadId,
          error: formatError(err),
        });
      }
    }
  }

  logEvent("info", "discord.thread.search.start", {
    forumId: forumChannelId,
    issueNumber,
    owner,
    repo,
  });

  // Fetch active threads
  const activeThreads = await forum.threads.fetchActive();
  const allThreads = [...activeThreads.threads.values()];
  logEvent("info", "discord.thread.search.active", {
    forumId: forumChannelId,
    issueNumber,
    count: allThreads.length,
  });

  // Fetch all archived threads (paginated)
  let hasMore = true;
  let before;
  let archivedPages = 0;
  while (hasMore) {
    try {
      const archived = await forum.threads.fetchArchived({ before, limit: 100 });
      const pageCount = archived.threads.size;
      allThreads.push(...archived.threads.values());
      hasMore = archived.hasMore;
      archivedPages += 1;
      logEvent("info", "discord.thread.search.archived_page", {
        forumId: forumChannelId,
        issueNumber,
        page: archivedPages,
        count: pageCount,
        hasMore,
      });
      if (pageCount > 0) {
        before = archived.threads.last().id;
      } else {
        hasMore = false;
      }
    } catch (err) {
      logEvent("error", "discord.thread.search.archived_error", {
        forumId: forumChannelId,
        issueNumber,
        error: formatError(err),
      });
      break;
    }
  }

  const repoLower = repo ? repo.toLowerCase() : null;
  const repoTagIds = repoLower
    ? forum.availableTags
        .filter((tag) => isRepoSelectorTag(tag) && tag.name.toLowerCase() === repoLower)
        .map((tag) => tag.id)
    : [];

  const taggedThreads = repoTagIds.length
    ? allThreads.filter((thread) =>
        (thread.appliedTags || []).some((tagId) => repoTagIds.includes(tagId))
      )
    : [];

  const candidateThreads = taggedThreads.length ? taggedThreads : allThreads;

  logEvent("info", "discord.thread.search.candidates", {
    forumId: forumChannelId,
    issueNumber,
    candidateCount: candidateThreads.length,
    repoTaggedCount: taggedThreads.length,
  });

  const normalizedIssueTitle = issueTitle
    ? issueTitle.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
    : null;

  const orderedThreads = [...candidateThreads].sort((a, b) => {
    if (!normalizedIssueTitle) return 0;
    const aName = a.name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const bName = b.name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const aMatch = normalizedIssueTitle && (aName.includes(normalizedIssueTitle) || normalizedIssueTitle.includes(aName));
    const bMatch = normalizedIssueTitle && (bName.includes(normalizedIssueTitle) || normalizedIssueTitle.includes(bName));
    if (aMatch === bMatch) return 0;
    return aMatch ? -1 : 1;
  });

  const PIN_FETCH_TIMEOUT_MS = 20000;
  const fetchPinnedWithTimeout = async (thread) => {
    const timeoutError = new Error("Pinned fetch timeout");
    timeoutError.code = "PIN_FETCH_TIMEOUT";
    return Promise.race([
      thread.messages.fetchPins(),
      new Promise((_, reject) =>
        setTimeout(() => reject(timeoutError), PIN_FETCH_TIMEOUT_MS)
      ),
    ]);
  };

  for (const thread of orderedThreads) {
    logEvent("info", "discord.thread.search.pin.start", {
      forumId: forumChannelId,
      issueNumber,
      threadId: thread.id,
      archived: thread.archived,
    });

    let pinnedResult;
    try {
      pinnedResult = await fetchPinnedWithTimeout(thread);
    } catch (err) {
      if (err.code === "PIN_FETCH_TIMEOUT") {
        logEvent("warn", "discord.thread.search.pin.timeout", {
          forumId: forumChannelId,
          issueNumber,
          threadId: thread.id,
          archived: thread.archived,
          timeoutMs: PIN_FETCH_TIMEOUT_MS,
        });
        continue;
      }
      logEvent("error", "discord.thread.search.pin.error", {
        forumId: forumChannelId,
        issueNumber,
        threadId: thread.id,
        archived: thread.archived,
        error: formatError(err),
      });
      continue;
    }

    const pinnedMessages = pinnedResult?.items || [];

    for (const item of pinnedMessages) {
      const message = item.message;
      // Parse synced issue info from pinned message
      const content = message.content;

      // Current format: `Synced with issue #N` on [repo-name](https://github.com/owner/repo)
      const currentMatch = content.match(/`Synced with issue #(\d+)`.*on \[.+?\]\(https:\/\/github\.com\/([^/]+)\/([^/)]+)/);
      if (currentMatch) {
        const msgIssueNum = parseInt(currentMatch[1], 10);
        const msgOwner = currentMatch[2];
        const msgRepo = currentMatch[3];

        if (msgIssueNum === issueNumber && (!owner || !repo || (msgOwner === owner && msgRepo === repo))) {
          threads.push(thread);
          logEvent("info", "discord.thread.search.match", {
            forumId: forumChannelId,
            issueNumber,
            threadId: thread.id,
            owner: msgOwner,
            repo: msgRepo,
          });
          await setThreadCacheEntry(msgOwner, msgRepo, issueNumber, {
            threadId: thread.id,
            title: thread.name,
          });
          break;
        }
        continue;
      }

      // Old format: `synced with issue #N` (backwards compat)
      const oldMatch = content.match(/`synced with issue #(\d+)`/i);
      if (oldMatch) {
        const msgIssueNum = parseInt(oldMatch[1], 10);
        const urlMatch = content.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/\d+/);
        const msgOwner = urlMatch ? urlMatch[1] : null;
        const msgRepo = urlMatch ? urlMatch[2] : null;

        if (msgIssueNum === issueNumber && (!owner || !repo || !msgOwner || !msgRepo || (msgOwner === owner && msgRepo === repo))) {
          threads.push(thread);
          logEvent("info", "discord.thread.search.match", {
            forumId: forumChannelId,
            issueNumber,
            threadId: thread.id,
            owner: msgOwner,
            repo: msgRepo,
          });
          if (msgOwner && msgRepo) {
            await setThreadCacheEntry(msgOwner, msgRepo, issueNumber, {
              threadId: thread.id,
              title: thread.name,
            });
          }
          break;
        }
      }
    }

    if (threads.length > 0) {
      break;
    }
  }

  logEvent("info", "discord.thread.search.complete", {
    forumId: forumChannelId,
    issueNumber,
    matches: threads.length,
    totalThreads: allThreads.length,
  });

  return threads;
}

module.exports = {
  SYNC_LABEL,
  REPO_TAG_EMOJI,
  CLOSED_TAG_NAME,
  CLOSED_TAG_EMOJI,
  logEvent,
  formatError,
  getDefaultRepo,
  getRepoOwner,
  getRepoName,
  getRandomColor,
  createDiscordClient,
  isForumThread,
  isRepoSelectorTag,
  isClosedTag,
  isClosedTagName,
  processMessageContent,
  getSyncedIssueInfo,
  getSyncedIssueNumbers,
  hasSyncLabel,
  isSyncLabel,
  formatDiscordAuthorComment,
  createSyncEmbed,
  createCommentEmbed,
  processGitHubIssueRefs,
  sleep,
  findThreadsForIssue,
  getOrCreateForumTag,
  getOrCreateClosedForumTag,
  getOrCreateGitHubLabel,
  getThreadCacheEntry,
  setThreadCacheEntry,
  deleteThreadCacheEntry,
};
