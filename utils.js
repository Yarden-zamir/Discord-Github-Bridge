const { Client, GatewayIntentBits } = require("discord.js");
const { env } = require("process");

const DISCORD_INTENTS = [
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.DirectMessages,
  GatewayIntentBits.Guilds,
  GatewayIntentBits.MessageContent,
];

const SYNC_LABEL = "🔵-synced";

let currentRepo = null;

function setTargetRepo(repo) {
  currentRepo = repo;
}

function getTargetRepo() {
  return currentRepo || env.TARGET_REPO;
}

function getRepoOwner() {
  return getTargetRepo().split("/")[0];
}

function getRepoName() {
  return getTargetRepo().split("/")[1];
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
    console.log("Pinned message content:", message.content);

    // Current format: `Synced with issue #N` on [repo-name](https://github.com/owner/repo)
    // Extract issue number and owner/repo from URL
    const currentMatch = message.content.match(/`Synced with issue #(\d+)`.*on \[.+?\]\(https:\/\/github\.com\/([^/]+)\/([^/)]+)/);
    if (currentMatch) {
      console.log("Matched current format:", { number: currentMatch[1], owner: currentMatch[2], repo: currentMatch[3] });
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
      console.log("Matched old format:", { number: oldMatch[1], urlMatch });
      issues.push({
        number: parseInt(oldMatch[1], 10),
        owner: urlMatch ? urlMatch[1] : null,
        repo: urlMatch ? urlMatch[2] : null,
      });
    }
  });

  console.log("Synced issues found:", issues);
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

async function getOrCreateForumTag(forum, tagName) {
  const existingTag = forum.availableTags.find(
    (t) => t.name.toLowerCase() === tagName.toLowerCase()
  );
  if (existingTag) return existingTag;

  // Create new tag (Discord limit: 20 tags per forum)
  if (forum.availableTags.length >= 20) {
    console.log(`Cannot create tag "${tagName}" - forum at 20 tag limit`);
    return null;
  }

  console.log(`Creating forum tag: ${tagName}`);
  await forum.setAvailableTags([...forum.availableTags, { name: tagName }]);

  // Refetch to get the new tag with ID
  const updatedForum = await forum.fetch();
  return updatedForum.availableTags.find(
    (t) => t.name.toLowerCase() === tagName.toLowerCase()
  );
}

async function getOrCreateGitHubLabel(octokit, labelName) {
  try {
    await octokit.request("GET /repos/{owner}/{repo}/labels/{name}", {
      owner: getRepoOwner(),
      repo: getRepoName(),
      name: labelName,
    });
    return labelName;
  } catch (err) {
    if (err.status === 404) {
      console.log(`Creating GitHub label: ${labelName}`);
      await octokit.request("POST /repos/{owner}/{repo}/labels", {
        owner: getRepoOwner(),
        repo: getRepoName(),
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

  // Fetch active threads
  const activeThreads = await forum.threads.fetchActive();
  const allThreads = [...activeThreads.threads.values()];

  // Fetch all archived threads (paginated)
  let hasMore = true;
  let before;
  while (hasMore) {
    const archived = await forum.threads.fetchArchived({ before, limit: 100 });
    allThreads.push(...archived.threads.values());
    hasMore = archived.hasMore;
    if (archived.threads.size > 0) {
      before = archived.threads.last().id;
    } else {
      hasMore = false;
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
          break;
        }
      }
    }
  }

  return threads;
}

module.exports = {
  SYNC_LABEL,
  setTargetRepo,
  getTargetRepo,
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
