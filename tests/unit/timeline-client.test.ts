import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

type Listener = (event: { state?: unknown }) => unknown;

class FakeElement {
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Listener[]>();
  readonly children: unknown[] = [];
  textContent = "";
  hidden = false;
  disabled = false;
  href = "";
  className = "";

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }

  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string) {
    this.attributes.delete(name);
  }

  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  async dispatch(type: string, event: { state?: unknown } = {}) {
    await Promise.all(
      (this.listeners.get(type) ?? []).map((listener) => listener(event)),
    );
    await Promise.resolve();
  }

  append(...children: unknown[]) {
    this.children.push(...children);
  }

  replaceChildren(...children: unknown[]) {
    this.children.splice(0, this.children.length, ...children);
  }
}

const clientHarness = async (search: string, fetchImpl: () => Promise<unknown>) => {
  const script = await readFile("public/scripts/timeline.js", "utf8");
  const root = new FakeElement();
  const stream = new FakeElement();
  const more = new FakeElement();
  const error = new FakeElement();
  const latest = new FakeElement();
  const configNode = new FakeElement();
  const initialNode = new FakeElement();
  const initial = {
    schemaVersion: 1,
    identity: "software-engineering:day:2026-08-15",
    domainId: "software-engineering",
    scale: "day",
    before: "2026-08-15",
    nextBefore: "2026-08-10",
    hasMore: true,
    groups: [],
    url: "/timeline/fragments/software-engineering/day/2026-08-15.json",
  };
  configNode.textContent = JSON.stringify({
    defaultDomain: "software-engineering",
    domains: [
      {
        id: "software-engineering",
        name: "软件工程",
        homeUrl: "/software-engineering/",
        scales: {
          day: {
            boundaries: ["2026-08-15", "2026-08-10"],
            firstUrl: initial.url,
          },
          week: {
            boundaries: ["2026-08-10"],
            firstUrl: "/timeline/fragments/software-engineering/week/2026-08-10.json",
          },
        },
      },
    ],
  });
  initialNode.textContent = JSON.stringify(initial);
  const selectors = new Map<string, FakeElement>([
    ["[data-timeline-root]", root],
    ["[data-timeline-stream]", stream],
    ["[data-timeline-more]", more],
    ["[data-timeline-error]", error],
    ["[data-timeline-latest]", latest],
    ["#timeline-config", configNode],
    ["#timeline-initial", initialNode],
  ]);
  const windowListeners = new Map<string, Listener[]>();
  const history = {
    state: null as unknown,
    replaceCalls: [] as unknown[][],
    pushCalls: [] as unknown[][],
    replaceState(...args: unknown[]) {
      this.state = args[0];
      this.replaceCalls.push(args);
    },
    pushState(...args: unknown[]) {
      this.state = args[0];
      this.pushCalls.push(args);
    },
  };
  const document = {
    querySelector: (selector: string) => selectors.get(selector) ?? null,
    querySelectorAll: () => [],
    createElement: () => new FakeElement(),
    createDocumentFragment: () => new FakeElement(),
  };
  const window = {
    location: { search },
    scrollY: 0,
    scrollTo() {},
    addEventListener(type: string, listener: Listener) {
      windowListeners.set(type, [...(windowListeners.get(type) ?? []), listener]);
    },
  };
  runInNewContext(script, {
    document,
    window,
    history,
    fetch: fetchImpl,
    URLSearchParams,
    TextEncoder,
    JSON,
    Error,
    Promise,
  });
  await Promise.resolve();
  await Promise.resolve();
  return { root, stream, more, error, latest, history };
};

describe("timeline client", () => {
  it("rejects an illegal cursor without requesting or silently falling back", async () => {
    let requests = 0;
    const harness = await clientHarness(
      "?domain=software-engineering&scale=day&before=2026-08-14",
      async () => {
        requests += 1;
        throw new Error("unexpected request");
      },
    );

    expect(requests).toBe(0);
    expect(harness.error.textContent).toBe("时间线链接无效");
    expect(harness.latest.hidden).toBe(false);
    expect(harness.history.replaceCalls).toHaveLength(0);
  });

  it("keeps DOM and history unchanged when an explicit load fails, then offers retry", async () => {
    const harness = await clientHarness(
      "?domain=software-engineering&scale=day",
      async () => {
        throw new Error("offline");
      },
    );
    const beforeChildren = [...harness.stream.children];
    const beforeHistory = harness.history.replaceCalls.length;

    await harness.more.dispatch("click");

    expect(harness.stream.children).toEqual(beforeChildren);
    expect(harness.history.pushCalls).toHaveLength(0);
    expect(harness.history.replaceCalls).toHaveLength(beforeHistory);
    expect(harness.more.textContent).toBe("重试");
    expect(harness.error.textContent).toBe("offline");
    expect(harness.root.attributes.has("aria-busy")).toBe(false);
  });

  it("rejects a structurally mismatched response before appending or pushing history", async () => {
    const corrupt = {
      schemaVersion: 1,
      identity: "software-engineering:day:2026-08-10",
      domainId: "software-engineering",
      scale: "day",
      before: "2026-08-10",
      hasMore: false,
      groups: [
        {
          kind: "day",
          date: "2026-08-13",
          insights: [
            {
              id: "insight-59498e27cf7aac1a9e4f9a76",
              url: "/insights/insight-59498e27cf7aac1a9e4f9a76/",
              sourceName: "Fixture Source",
              status: "updated",
              statusLabel: "新发布",
              title: "Reliable agent architecture",
              summary: "不可变输入让自动化结果可重放。",
            },
          ],
        },
      ],
      url: "/timeline/fragments/software-engineering/day/2026-08-10.json",
    };
    const harness = await clientHarness(
      "?domain=software-engineering&scale=day",
      async () => ({ ok: true, text: async () => JSON.stringify(corrupt) }),
    );
    const beforeChildren = [...harness.stream.children];

    await harness.more.dispatch("click");

    expect(harness.stream.children).toEqual(beforeChildren);
    expect(harness.history.pushCalls).toHaveLength(0);
    expect(harness.more.textContent).toBe("重试");
    expect(harness.error.textContent).toBe("时间线片段校验失败");
  });
});
