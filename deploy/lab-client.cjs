/* One persistent browser session on the isolated service network. */
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const net = require("node:net");
const readline = require("node:readline");
const { chromium } = require("/workspace/node_modules/playwright");

const origin = `http://${process.argv[2]}:8080`;
const outside = [];
const requests = [];
const failedResources = [];
const resourceTypes = new Set(["stylesheet", "script", "image", "font", "fetch", "xhr"]);
let previousEtag;
let previousHtmlEtag;
let previousAsset;

const externalBlocked = () =>
  new Promise((resolve) => {
    const socket = net.connect({ host: "1.1.1.1", port: 443 });
    const finish = (blocked) => {
      socket.destroy();
      resolve(blocked);
    };
    socket.once("connect", () => finish(false));
    socket.once("error", () => finish(true));
    socket.setTimeout(2000, () => finish(true));
  });

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ serviceWorkers: "block" });
  context.on("request", (request) => {
    const url = new URL(request.url());
    if (url.protocol === "http:" || url.protocol === "https:") {
      requests.push(url.pathname + url.search);
      if (url.origin !== origin) outside.push(request.url());
    }
  });
  context.on("requestfailed", (request) => {
    if (resourceTypes.has(request.resourceType())) failedResources.push(request.url());
  });
  context.on("response", (response) => {
    if (
      response.status() >= 400 &&
      resourceTypes.has(response.request().resourceType())
    ) {
      failedResources.push(response.url());
    }
  });
  const page = await context.newPage();
  const get = (path, headers = {}) =>
    context.request.get(origin + path, { headers, timeout: 15_000 });
  console.log(JSON.stringify({ status: "ready" }));
  try {
    for await (const line of readline.createInterface({ input: process.stdin })) {
      const command = JSON.parse(line);
      if (command.action === "close") break;
      const release = await get(
        "/release.json",
        previousEtag ? { "If-None-Match": previousEtag } : {},
      );
      assert.equal(release.status(), 200);
      assert.equal((await release.json()).buildSha, command.sha);
      assert.match(release.headers()["cache-control"], /no-cache/);
      assert.equal(release.headers()["strict-transport-security"], undefined);
      previousEtag = release.headers().etag;
      const metadataResponse = await get("/_publication.json");
      assert.equal(metadataResponse.status(), 200);
      const metadata = await metadataResponse.json();
      assert.equal(metadata.buildSha, command.sha);
      const families = [
        (route) => route === "/software-engineering/",
        (route) => route === "/timeline/",
        (route) => route === "/software-engineering/topics/",
        (route) => route.startsWith("/topics/"),
        (route) => route.startsWith("/tags/"),
        (route) => route.startsWith("/insights/"),
        (route) => route.startsWith("/sources/"),
      ];
      assert(families.every((matches) => metadata.routes.some(matches)));
      for (const route of metadata.routes) {
        assert(route.startsWith("/") && !route.startsWith("//"));
        const response = await page.goto(origin + route, { waitUntil: "networkidle" });
        assert.equal(response.status(), 200);
        assert.match(response.headers()["content-security-policy"], /connect-src 'self'/);
        assert.equal(response.headers()["strict-transport-security"], undefined);
      }
      const home = await get(
        "/software-engineering/",
        previousHtmlEtag ? { "If-None-Match": previousHtmlEtag } : {},
      );
      assert.equal(home.status(), 200);
      assert((await home.text()).includes(command.marker));
      previousHtmlEtag = home.headers().etag;
      await page.goto(origin + "/software-engineering/", { waitUntil: "networkidle" });
      assert((await page.locator("body").innerText()).includes(command.marker));
      for (const asset of metadata.assets) {
        const response = await get(asset.url);
        assert.equal(response.status(), 200);
        assert.match(response.headers()["cache-control"], /immutable/);
        assert.equal(
          createHash("sha256")
            .update(await response.body())
            .digest("hex"),
          asset.sha256,
        );
      }
      if (previousAsset) {
        const response = await get(previousAsset.url);
        assert.equal(response.status(), 200);
        assert.equal(
          createHash("sha256")
            .update(await response.body())
            .digest("hex"),
          previousAsset.sha256,
        );
      }
      previousAsset = metadata.assets[0];
      for (const privatePath of [
        "/candidates/",
        "/versions/",
        "/current/",
        "/state.json",
      ]) {
        assert.equal((await get(privatePath)).status(), 404);
      }
      assert.deepEqual(outside, []);
      assert.deepEqual(failedResources, []);
      assert(await externalBlocked());
      console.log(
        JSON.stringify({
          status: "passed",
          sha: command.sha,
          marker: command.marker,
          routes: metadata.routes.length,
          page_families: 7,
          assets: metadata.assets.length,
          external_requests: outside,
          failed_resources: failedResources,
          external_network: "blocked",
          request_paths: requests,
          html_etag: previousHtmlEtag,
          release_etag: previousEtag,
        }),
      );
    }
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
