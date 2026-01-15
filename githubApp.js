const { env } = require("process");
const { logEvent } = require("./utils.js");

let app = null;
let webhooks = null;
let AppClass = null;
let WebhooksClass = null;
let createNodeMiddlewareFn = null;

async function loadOctokitModules() {
  if (AppClass && WebhooksClass && createNodeMiddlewareFn) return;

  const appModule = await import("@octokit/app");
  const webhookModule = await import("@octokit/webhooks");

  AppClass = appModule.App;
  WebhooksClass = webhookModule.Webhooks;
  createNodeMiddlewareFn = webhookModule.createNodeMiddleware;
}

async function getApp() {
  if (!app) {
    if (!env.GITHUB_APP_ID) {
      throw new Error("GITHUB_APP_ID env var not set");
    }
    if (!env.GITHUB_APP_PRIVATE_KEY) {
      throw new Error("GITHUB_APP_PRIVATE_KEY env var not set");
    }

    const privateKey = env.GITHUB_APP_PRIVATE_KEY.includes("BEGIN")
      ? env.GITHUB_APP_PRIVATE_KEY
      : require("fs").readFileSync(env.GITHUB_APP_PRIVATE_KEY, "utf8");

    await loadOctokitModules();

    logEvent("info", "github.app.init", { appId: env.GITHUB_APP_ID });

    app = new AppClass({
      appId: env.GITHUB_APP_ID,
      privateKey,
    });
  }
  return app;
}

async function getWebhooks() {
  if (!webhooks) {
    await loadOctokitModules();
    webhooks = new WebhooksClass({
      secret: env.GITHUB_WEBHOOK_SECRET || "development",
    });
  }
  return webhooks;
}

async function getWebhookMiddleware() {
  await loadOctokitModules();
  const activeWebhooks = await getWebhooks();
  return createNodeMiddlewareFn(activeWebhooks, {
    path: "/github/webhooks",
  });
}

async function getInstallationOctokit(installationId) {
  const currentApp = await getApp();
  return currentApp.getInstallationOctokit(installationId);
}

module.exports = {
  getApp,
  getWebhooks,
  getWebhookMiddleware,
  getInstallationOctokit,
};
