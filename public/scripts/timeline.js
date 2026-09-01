(() => {
  const root = document.querySelector("[data-timeline-root]");
  const stream = document.querySelector("[data-timeline-stream]");
  const more = document.querySelector("[data-timeline-more]");
  const error = document.querySelector("[data-timeline-error]");
  const latest = document.querySelector("[data-timeline-latest]");
  const configNode = document.querySelector("#timeline-config");
  const initialNode = document.querySelector("#timeline-initial");
  if (!root || !stream || !more || !error || !latest || !configNode || !initialNode) {
    return;
  }

  const config = JSON.parse(configNode.textContent || "null");
  const embeddedInitial = JSON.parse(initialNode.textContent || "null");
  let fragments = [];
  let requestContext;
  let pending = false;

  const contextFor = (search) => {
    const params = new URLSearchParams(search);
    const explicitDomain = params.get("domain");
    const explicitScale = params.get("scale");
    const domainId = explicitDomain || config.defaultDomain;
    const scale = explicitScale || "day";
    const domain = config.domains.find((candidate) => candidate.id === domainId);
    if (
      !domain ||
      (scale !== "day" && scale !== "week") ||
      (explicitDomain !== null && explicitDomain !== domainId) ||
      (explicitScale !== null && explicitScale !== scale)
    ) {
      return undefined;
    }
    const before = params.get("before") || undefined;
    const scaleConfig = domain.scales[scale];
    if (
      !scaleConfig.firstUrl ||
      (before !== undefined &&
        (!/^\d{4}-\d{2}-\d{2}$/.test(before) || !scaleConfig.boundaries.includes(before)))
    ) {
      return undefined;
    }
    return { domain, domainId, scale, before, scaleConfig };
  };

  const canonicalUrl = (context, before) => {
    const params = new URLSearchParams({
      domain: context.domainId,
      scale: context.scale,
    });
    if (before) params.set("before", before);
    return `/timeline/?${params.toString()}`;
  };

  const exactKeys = (value, keys) =>
    value &&
    typeof value === "object" &&
    Object.keys(value).sort().join("\n") === [...keys].sort().join("\n");

  const calendarTime = (value) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
    const parsed = Date.parse(`${value}T00:00:00Z`);
    return Number.isFinite(parsed) &&
      new Date(parsed).toISOString().slice(0, 10) === value
      ? parsed
      : undefined;
  };

  const moveDate = (value, days) =>
    new Date(calendarTime(value) + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const validCard = (card) =>
    exactKeys(card, [
      "id",
      "url",
      "sourceName",
      "status",
      "statusLabel",
      "title",
      "summary",
    ]) &&
    /^insight-[a-f0-9]{24}$/.test(card.id) &&
    card.url === `/insights/${card.id}/` &&
    typeof card.sourceName === "string" &&
    (card.status === "new" || card.status === "updated") &&
    card.statusLabel === (card.status === "new" ? "新发布" : "已更新") &&
    typeof card.title === "string" &&
    typeof card.summary === "string";

  const validateFragment = (value, context, expectedBefore) => {
    const expectedUrl = `/timeline/fragments/${context.domainId}/${context.scale}/${expectedBefore}.json`;
    const expectedKeys = [
      "schemaVersion",
      "identity",
      "domainId",
      "scale",
      "before",
      "hasMore",
      "groups",
      "url",
      ...(value?.hasMore ? ["nextBefore"] : []),
    ];
    const seenGroups = new Set();
    const boundaryTime = calendarTime(expectedBefore);
    const validGroups =
      Array.isArray(value?.groups) &&
      value.groups.every((group) => {
        const groupInsightIds = new Set();
        const groupKey =
          context.scale === "day"
            ? exactKeys(group, ["kind", "date", "insights"]) &&
              group.kind === "day" &&
              calendarTime(group.date) !== undefined &&
              calendarTime(group.date) >= boundaryTime &&
              calendarTime(group.date) <= boundaryTime + 4 * 24 * 60 * 60 * 1000
              ? group.date
              : undefined
            : exactKeys(group, ["kind", "weekStart", "weekEnd", "insights"]) &&
                group.kind === "week" &&
                group.weekStart === expectedBefore &&
                group.weekEnd === moveDate(expectedBefore, 6)
              ? group.weekStart
              : undefined;
        if (
          !groupKey ||
          seenGroups.has(groupKey) ||
          !Array.isArray(group.insights) ||
          !group.insights.every(validCard) ||
          group.insights.some((card) => {
            if (groupInsightIds.has(card.id)) return true;
            groupInsightIds.add(card.id);
            return false;
          })
        ) {
          return false;
        }
        seenGroups.add(groupKey);
        return true;
      });
    const expectedNext = moveDate(expectedBefore, context.scale === "day" ? -5 : -7);
    if (
      !exactKeys(value, expectedKeys) ||
      value.schemaVersion !== 1 ||
      value.identity !== `${context.domainId}:${context.scale}:${expectedBefore}` ||
      value.domainId !== context.domainId ||
      value.scale !== context.scale ||
      value.before !== expectedBefore ||
      value.url !== expectedUrl ||
      typeof value.hasMore !== "boolean" ||
      !validGroups ||
      value.groups.reduce((total, group) => total + group.insights.length, 0) >
        (context.scale === "day" ? 15 : 10) ||
      value.hasMore !== (typeof value.nextBefore === "string") ||
      (value.nextBefore &&
        (value.nextBefore !== expectedNext ||
          !context.scaleConfig.boundaries.includes(value.nextBefore)))
    ) {
      throw new Error("时间线片段校验失败");
    }
    return value;
  };

  const fetchFragment = async (url, context, before) => {
    const response = await fetch(url, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`时间线请求失败：${response.status}`);
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > 256 * 1024) {
      throw new Error("时间线片段超过 256 KiB");
    }
    return validateFragment(JSON.parse(text), context, before);
  };

  const element = (name, text, className) => {
    const node = document.createElement(name);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };

  const groupElement = (group) => {
    const section = element("section", undefined, "timeline-group");
    section.setAttribute("data-timeline-group", "");
    const header = element("header");
    header.append(element("p", group.kind === "day" ? "DAILY" : "WEEKLY"));
    header.append(
      element(
        "h2",
        group.kind === "day" ? group.date : `${group.weekStart} — ${group.weekEnd}`,
      ),
    );
    section.append(header);
    const list = element("ol");
    for (const insight of group.insights) {
      const item = element("li");
      item.setAttribute("data-timeline-insight", insight.id);
      const link = element("a");
      link.href = insight.url;
      const metadata = element("p");
      metadata.append(element("span", insight.sourceName));
      metadata.append(element("em", insight.statusLabel));
      link.append(metadata, element("h3", insight.title), element("p", insight.summary));
      item.append(link);
      list.append(item);
    }
    section.append(list);
    return section;
  };

  const updateControls = (context) => {
    root.setAttribute("data-domain", context.domainId);
    root.setAttribute("data-scale", context.scale);
    for (const link of document.querySelectorAll("[data-timeline-domains] a")) {
      const selected = link.getAttribute("data-domain") === context.domainId;
      if (selected) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
      const targetDomain = link.getAttribute("data-domain");
      link.href = canonicalUrl({ ...context, domainId: targetDomain }, undefined);
    }
    for (const link of document.querySelectorAll("[data-timeline-scales] a")) {
      const targetScale = link.getAttribute("data-scale");
      const selected = targetScale === context.scale;
      if (selected) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
      link.href = canonicalUrl({ ...context, scale: targetScale }, undefined);
    }
    latest.href = canonicalUrl(context, undefined);
  };

  const render = (nextFragments) => {
    const candidate = document.createDocumentFragment();
    for (const fragment of nextFragments) {
      for (const group of fragment.groups) candidate.append(groupElement(group));
    }
    stream.replaceChildren(candidate);
    const last = nextFragments.at(-1);
    more.hidden = !last?.hasMore;
    more.textContent = "查看更早洞察";
    error.hidden = true;
    latest.hidden = true;
    fragments = nextFragments;
  };

  const showInvalidLink = () => {
    const params = new URLSearchParams(window.location.search);
    const requestedDomain = config.domains.find(
      (candidate) => candidate.id === params.get("domain"),
    );
    const requestedScale = params.get("scale");
    const latestContext = {
      domainId: requestedDomain?.id || config.defaultDomain,
      scale: requestedScale === "week" ? "week" : "day",
    };
    stream.replaceChildren();
    more.hidden = true;
    error.textContent = "时间线链接无效";
    error.hidden = false;
    latest.hidden = false;
    latest.href = canonicalUrl(latestContext, undefined);
  };

  const recover = async (context) => {
    const firstBefore = context.scaleConfig.boundaries[0];
    let current =
      context.domainId === config.defaultDomain && context.scale === "day"
        ? validateFragment(embeddedInitial, context, firstBefore)
        : await fetchFragment(context.scaleConfig.firstUrl, context, firstBefore);
    const recovered = [current];
    while (context.before && current.before !== context.before) {
      if (!current.nextBefore) throw new Error("时间线链接无效");
      current = await fetchFragment(
        `/timeline/fragments/${context.domainId}/${context.scale}/${current.nextBefore}.json`,
        context,
        current.nextBefore,
      );
      recovered.push(current);
    }
    return recovered;
  };

  const restoredFragments = (state, context) => {
    if (
      state?.timeline?.domainId !== context.domainId ||
      state.timeline.scale !== context.scale ||
      !Array.isArray(state.timeline.fragments) ||
      state.timeline.fragments.length === 0
    ) {
      return undefined;
    }
    const restored = [];
    let expectedBefore = context.scaleConfig.boundaries[0];
    for (const fragment of state.timeline.fragments) {
      const checked = validateFragment(fragment, context, expectedBefore);
      restored.push(checked);
      expectedBefore = checked.nextBefore;
    }
    const targetBefore = context.before || context.scaleConfig.boundaries[0];
    return restored.at(-1)?.before === targetBefore ? restored : undefined;
  };

  const initialize = async (state) => {
    const context = contextFor(window.location.search);
    if (!context) {
      showInvalidLink();
      return;
    }
    requestContext = context;
    updateControls(context);
    try {
      const restored = restoredFragments(state, context) || (await recover(context));
      render(restored);
      history.replaceState(
        {
          timeline: {
            domainId: context.domainId,
            scale: context.scale,
            fragments: restored,
            scrollY: state?.timeline?.scrollY || 0,
          },
        },
        "",
        canonicalUrl(context, context.before),
      );
      if (state?.timeline?.scrollY) window.scrollTo(0, state.timeline.scrollY);
    } catch (_failure) {
      showInvalidLink();
    }
  };

  more.addEventListener("click", async () => {
    if (pending || !requestContext) return;
    const current = fragments.at(-1);
    if (!current?.nextBefore) return;
    pending = true;
    more.disabled = true;
    more.textContent = "正在加载…";
    root.setAttribute("aria-busy", "true");
    try {
      const next = await fetchFragment(
        `/timeline/fragments/${requestContext.domainId}/${requestContext.scale}/${current.nextBefore}.json`,
        requestContext,
        current.nextBefore,
      );
      const nextFragments = [...fragments, next];
      history.replaceState(
        {
          timeline: {
            domainId: requestContext.domainId,
            scale: requestContext.scale,
            fragments,
            scrollY: window.scrollY,
          },
        },
        "",
      );
      render(nextFragments);
      history.pushState(
        {
          timeline: {
            domainId: requestContext.domainId,
            scale: requestContext.scale,
            fragments: nextFragments,
            scrollY: window.scrollY,
          },
        },
        "",
        canonicalUrl(requestContext, next.before),
      );
    } catch (failure) {
      error.textContent = failure instanceof Error ? failure.message : "时间线加载失败";
      error.hidden = false;
      more.textContent = "重试";
    } finally {
      pending = false;
      more.disabled = false;
      root.removeAttribute("aria-busy");
    }
  });

  window.addEventListener("popstate", (event) => void initialize(event.state));
  window.addEventListener("pagehide", () => {
    if (!requestContext || fragments.length === 0) return;
    history.replaceState(
      {
        timeline: {
          domainId: requestContext.domainId,
          scale: requestContext.scale,
          fragments,
          scrollY: window.scrollY,
        },
      },
      "",
    );
  });
  void initialize(history.state);
})();
