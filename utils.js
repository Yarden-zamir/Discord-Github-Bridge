const { Client, GatewayIntentBits } = require("discord.js");
const { env } = require("process");

const DISCORD_INTENTS = [
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.DirectMessages,
  GatewayIntentBits.Guilds,
  GatewayIntentBits.MessageContent,
];

const SYNC_LABEL = "🔵-synced";
const REPO_TAG_EMOJI = env.REPO_TAG_EMOJI || "🧭";

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
  const pinnedMessages = await channel.messages.fetchPinned();
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

async function findThreadsForIssue(client, forumChannelId, issueNumber, owner = null, repo = null) {
  const threads = [];
  const forum = await client.channels.fetch(forumChannelId);

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

  for (const thread of allThreads) {
    const pinnedMessages = await thread.messages.fetchPinned();
    for (const [, message] of pinnedMessages) {
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
          break;
        }
      }
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
  logEvent,
  formatError,
  getDefaultRepo,
  getRepoOwner,
  getRepoName,
  getRandomColor,
  createDiscordClient,
  isForumThread,
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
  getOrCreateGitHubLabel,
};
