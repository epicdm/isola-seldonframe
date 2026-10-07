import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import {
  buildEmbedTurnUrl,
  isEmbedAgentAccessible,
  resolveRequestedEmbedAgent,
} from "../../../src/lib/agents/public-embed-resolution";

const workspace = "uplinks-workspace-4816";
const agents = [
  { id: "draft-test", orgSlug: workspace, slug: "personal-line-faq-test-internal", status: "draft" },
  { id: "live-sales", orgSlug: workspace, slug: "default", status: "live" },
  { id: "other-default", orgSlug: "another-workspace", slug: "private", status: "live" },
];

test("resolves only the explicitly requested agent in its workspace", () => {
  const route = readFileSync(
    path.resolve(__dirname, "../../../src/app/api/v1/public/agent/[slug]/embed.js/route.ts"),
    "utf8",
  );
  assert.match(route, /\.where\(and\([\s\S]*?eq\(organizations\.slug, orgSlugPart\)[\s\S]*?eq\(agents\.slug, agentSlugPart\)/);
  assert.match(route, /resolveRequestedEmbedAgent\(agentRows, orgSlugPart, agentSlugPart\)/);
  assert.match(route, /isEmbedAgentAccessible\(agentRow\.status\)/);
  assert.equal(resolveRequestedEmbedAgent(agents, workspace, "default")?.id, "live-sales");
  assert.equal(resolveRequestedEmbedAgent(agents, workspace, "personal-line-faq-test-internal")?.id, "draft-test");
  assert.equal(isEmbedAgentAccessible("draft"), false);
  assert.equal(isEmbedAgentAccessible("live"), true);
  assert.equal(isEmbedAgentAccessible("test"), true);
  assert.equal(resolveRequestedEmbedAgent(agents, workspace, "not-a-real-agent"), null);
  assert.equal(resolveRequestedEmbedAgent(agents, workspace, "00000000-0000-0000-0000-000000000000"), null);
  assert.equal(resolveRequestedEmbedAgent(agents, workspace, "private"), null);
  assert.equal(resolveRequestedEmbedAgent(agents, "another-workspace", "private")?.id, "other-default");
});

class WidgetElement {
  children: WidgetElement[] = [];
  handlers = new Map<string, (event: WidgetEvent) => unknown>();
  attributes = new Map<string, string>();
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  className = "";
  value = "";
  disabled = false;
  scrollTop = 0;
  scrollHeight = 0;
  textContent: string | null = null;
  _innerHTML = "";
  selectors = new Map<string, WidgetElement>();
  parent: WidgetElement | null = null;
  classList: { add(value: string): void; remove(value: string): void; contains(value: string): boolean } = {
    add: (value: string) => { if (!this.className.split(/\s+/).includes(value)) this.className = `${this.className} ${value}`.trim(); },
    remove: (value: string) => { this.className = this.className.split(/\s+/).filter((item) => item !== value).join(" "); },
    contains: (value: string) => this.className.split(/\s+/).includes(value),
  };

  constructor(readonly tagName: string) {}
  get innerHTML() { return this._innerHTML; }
  set innerHTML(value) {
    this._innerHTML = value;
    if (value.includes('id="sf-agent-form"')) this.setPanelMarkup();
  }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  addEventListener(name: string, handler: (event: WidgetEvent) => unknown) { this.handlers.set(name, handler); }
  appendChild(child: WidgetElement) { child.parent = this; this.children.push(child); return child; }
  remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); }
  focus() {}
  querySelector(selector: string) { return this.selectors.get(selector) ?? null; }
  setPanelMarkup() {
    for (const [selector, tag] of [
      ["#sf-agent-msgs", "div"], ["#sf-agent-form", "form"],
      ["#sf-agent-input", "textarea"], [".sf-agent-send", "button"],
      [".sf-agent-close", "button"],
    ]) {
      const child = new WidgetElement(tag);
      child.parent = this;
      this.selectors.set(selector, child);
    }
  }
}
type WidgetEvent = { preventDefault(): void; key?: string; shiftKey?: boolean };

test("the generated embed script sends the visitor turn to the selected sales agent", async () => {
  const routePath = path.resolve(__dirname, "../../../src/app/api/v1/public/agent/[slug]/embed.js/route.ts");
  const routeSource = readFileSync(routePath, "utf8");
  const start = routeSource.indexOf("function renderEmbedScript(input: {");
  const end = routeSource.lastIndexOf("\n}");
  assert.ok(start >= 0 && end > start, "route contains the installed script builder");
  const typedBuilder = routeSource.slice(start, end + 2);
  const jsBuilder = typedBuilder.replace(
    /^function renderEmbedScript\(input: \{[\s\S]*?\}\): string \{/,
    "function renderEmbedScript(input) {",
  );
  const renderEmbedScript = vm.runInNewContext(`(${jsBuilder})`) as (input: any) => string;

  const turnUrl = buildEmbedTurnUrl("https://uplink.epic.dm", workspace, "default");
  const script = renderEmbedScript({
    turnUrl,
    greeting: "Welcome",
    tokens: {
      primary: "#111111", secondary: "#e5e5e1", background: "#f7f7f5",
      text: "#111111", border: "#e5e5e1", headlineFont: "Geist", bodyFont: "Geist",
    },
    googleFontUrl: null,
    orgName: "Uplink",
    logoUrl: null,
    orgSlug: workspace,
    platformName: "SeldonFrame",
    platformHomeUrl: "https://www.seldonframe.com",
    licenseUrl: "https://uplink.epic.dm/license",
    showVendorAttribution: false,
  });

  const head = new WidgetElement("head");
  const body = new WidgetElement("body");
  const document = {
    head,
    body,
    referrer: "https://uplink.epic.dm/personal-line",
    createElement: (tag: string) => {
      const element = new WidgetElement(tag);
      if (tag === "div" && body.children.length > 0) element.setPanelMarkup();
      return element;
    },
    querySelector: () => null,
    addEventListener: () => undefined,
  };
  const requests: Array<{ url: string; body: string }> = [];
  const storage = new Map();
  const sandbox = {
    window: { __sf_agent_loaded__: false },
    document,
    location: { href: "https://uplink.epic.dm/personal-line" },
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
    fetch: async (url: string, init: { body: string }) => {
      requests.push({ url, body: init.body });
      return {
        headers: { get: () => "application/json" },
        json: async () => ({ conversation_id: "fixture-conversation", message: "Plans are available." }),
      };
    },
    Math,
    Date,
    encodeURIComponent,
    setTimeout: (callback: () => void) => callback(),
  };
  vm.runInNewContext(script, sandbox);

  const panel = body.children.find((child) => child.className === "sf-agent-panel");
  const form = panel?.querySelector("#sf-agent-form");
  const input = panel?.querySelector("#sf-agent-input");
  assert.ok(panel);
  assert.ok(form);
  assert.ok(input);
  input.value = "What plans are available?";
  const submit = form.handlers.get("submit");
  assert.ok(submit);
  await submit({ preventDefault() {} });

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, "https://uplink.epic.dm/api/v1/public/agent/uplinks-workspace-4816--default/turn");
  assert.equal(JSON.parse(requests[0].body).message, "What plans are available?");
  assert.equal(panel.querySelector("#sf-agent-msgs")?.children.at(-1)?.innerHTML, "Plans are available.");
});
