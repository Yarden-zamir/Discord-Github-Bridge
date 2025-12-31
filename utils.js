const { Client, GatewayIntentBits } = require("discord.js");
const { env } = require("process");

const DISCORD_INTENTS = [
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.DirectMessages,
  GatewayIntentBits.Guilds,
  GatewayIntentBits.MessageContent,
];

const SYNC_LABEL = "🔵-synced";

function getRepoOwner() {
  return env.TARGET_REPO.split("/")[0];
}

function getRepoName() {
  return env.TARGET_REPO.split("/")[1];
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

async function getSyncedIssueNumbers(channel) {
  const pinnedMessages = await channel.messages.fetchPinned();
  const issueNumbers = [];

  pinnedMessages.forEach((message) => {
    const match = message.cleanContent.match(/`synced with issue #(\d+)`/);
    if (match) {
      issueNumbers.push(parseInt(match[1], 10));
    }
  });

  return issueNumbers;
}

function hasSyncLabel(issue) {
  return issue.labels?.some((label) => label.name === SYNC_LABEL);
}

function formatDiscordAuthorComment(author, messageUrl, content) {
  const avatarUrl = author.avatarURL() || author.defaultAvatarURL;
  return `[<img src="${avatarUrl}" width="15" height="15"/> **${author.username}** on Discord says](${messageUrl})\n${content}`;
}

function createSyncEmbed(issueNumber, title, body, htmlUrl, author) {
  return {
    content: `\`synced with issue #${issueNumber}\` [follow on github](${htmlUrl})`,
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

function createCommentEmbed(comment) {
  return {
    embeds: [
      {
        description: comment.body,
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
    await octokit.rest.issues.getLabel({
      owner: getRepoOwner(),
      repo: getRepoName(),
      name: labelName,
    });
    return labelName;
  } catch (err) {
    if (err.status === 404) {
      console.log(`Creating GitHub label: ${labelName}`);
      await octokit.rest.issues.createLabel({
        owner: getRepoOwner(),
        repo: getRepoName(),
        name: labelName,
      });
      return labelName;
    }
    throw err;
  }
}

async function findThreadsForIssue(client, forumChannelId, issueNumber) {
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
      if (message.cleanContent.includes(`\`synced with issue #${issueNumber}\``)) {
        threads.push(thread);
        break;
      }
    }
  }

  return threads;
}

module.exports = {
  SYNC_LABEL,
  getRepoOwner,
  getRepoName,
  getRandomColor,
  createDiscordClient,
  isForumThread,
  processMessageContent,
  getSyncedIssueNumbers,
  hasSyncLabel,
  isSyncLabel,
  formatDiscordAuthorComment,
  createSyncEmbed,
  createCommentEmbed,
  sleep,
  findThreadsForIssue,
  getOrCreateForumTag,
  getOrCreateGitHubLabel,
};
