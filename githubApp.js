const { App } = require("@octokit/app");
const { Webhooks, createNodeMiddleware } = require("@octokit/webhooks");
const { env } = require("process");
const { logEvent } = require("./utils.js");

let app = null;
let webhooks = null;

function getApp() {
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

    logEvent("info", "github.app.init", { appId: env.GITHUB_APP_ID });

    app = new App({
      appId: env.GITHUB_APP_ID,
      privateKey,
    });
  }
  return app;
}

function getWebhooks() {
  if (!webhooks) {
    webhooks = new Webhooks({
      secret: env.GITHUB_WEBHOOK_SECRET || "development",
    });
  }
  return webhooks;
}

function getWebhookMiddleware() {
  return createNodeMiddleware(getWebhooks(), {
    path: "/github/webhooks",
  });
}

async function getInstallationOctokit(installationId) {
  return getApp().getInstallationOctokit(installationId);
}

module.exports = {
  getApp,
  getWebhooks,
  getWebhookMiddleware,
  getInstallationOctokit,
};
