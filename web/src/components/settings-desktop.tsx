// Settings → Desktop app, shown only inside the desktop app: the etude command and the logs. Its
// updates are under About, like everywhere else.
import { useEffect, useState } from "react";
import { Check, Copy, FolderOpen, Loader2, Terminal } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { BigSwitch, Block, Section } from "@/components/settings-ui";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SEARCH_ENGINES, canWebTabs, linksInTabs, searchEngine, setLinksInTabs, setSearchEngine, useWebSettings, type SearchEngine } from "@/lib/web-tabs";
import { desktopApp, type DesktopCommandState } from "@/lib/platform";

function CommandStatus({ cmd }: { cmd: DesktopCommandState | null }) {
  if (!cmd) return <p className="text-sm text-muted-foreground">Checking…</p>;
  if (cmd.path && cmd.ours)
    return (
      <p className="flex items-center gap-1.5 text-sm">
        <Check className="size-3.5 text-muted-foreground" />
        Installed: <code className="rounded bg-muted px-1 py-0.5 font-mono text-[12px]">{cmd.path}</code>
      </p>
    );
  if (cmd.path)
    return (
      <p className="text-sm text-muted-foreground">
        There's already an etude at <code className="rounded bg-muted px-1 py-0.5 font-mono text-[12px] text-foreground/85">{cmd.path}</code>, from npm or a copy of the source code. Etude leaves it as it is.
      </p>
    );
  return <p className="text-sm text-muted-foreground">{cmd.note}</p>;
}

/** How to hand the collection to an AI agent over MCP: one line per agent, ready to paste. */
function AgentSetup({ cmd }: { cmd: DesktopCommandState | null }) {
  const bin = cmd?.path && cmd.ours ? cmd.path : "etude";
  const json = `{\n  "mcpServers": {\n    "etude": { "command": ${JSON.stringify(bin)}, "args": ["mcp"] }\n  }\n}`;
  const lines: [string, string][] = [
    ["Claude Code", `claude mcp add etude -- ${bin} mcp`],
    ["Codex", `codex mcp add etude -- ${bin} mcp`],
    ["Claude Desktop, Cursor and others (their MCP settings file)", json],
  ];
  const copy = (text: string) => void navigator.clipboard.writeText(text).then(() => toast.success("Copied"));
  return (
    <div className="flex flex-col gap-3">
      {lines.map(([who, text]) => (
        <div key={who} className="flex flex-col gap-1">
          <span className="text-[12.5px] text-muted-foreground">{who}</span>
          <div className="flex items-start gap-2">
            <pre className="min-w-0 flex-1 overflow-x-auto rounded-lg bg-muted px-2.5 py-1.5 font-mono text-[12px] leading-relaxed">{text}</pre>
            <Button variant="ghost" size="icon" className="phone:size-10 size-8 shrink-0" aria-label={`Copy the ${who} setup`} onClick={() => copy(text)}>
              <Copy className="size-3.5" />
            </Button>
          </div>
        </div>
      ))}
      <p className="text-[12.5px] text-muted-foreground">Add <code className="font-mono">--read-only</code> after <code className="font-mono">mcp</code> to let an agent look without changing anything.</p>
    </div>
  );
}

export function DesktopSection() {
  const app = desktopApp();
  const [cmd, setCmd] = useState<DesktopCommandState | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void app?.command.status().then(setCmd);
  }, [app]);
  if (!app) return null;

  const install = async () => {
    setBusy(true);
    try {
      const r = await app.command.install();
      setCmd(r);
      if (r.error) toast.error("Couldn't install the etude command", { description: r.error });
      else toast.success("The etude command is installed", { description: "Open a new terminal and try etude --help." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section id="desktop" title="Desktop app">
      <Block
        title="The etude command"
        description="The command line for scripts and agents, always the same version as this app. It needs no Node of its own."
        stackAside
        aside={
          cmd?.canInstall && !cmd.ours ? (
            <Button variant="outline" size="sm" className="phone:h-10 gap-1.5 h-8" disabled={busy} onClick={install}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Terminal className="size-4" />}
              Install the etude command
            </Button>
          ) : undefined
        }
      >
        <CommandStatus cmd={cmd} />
      </Block>
      {canWebTabs() && <WebBlocks />}
      <Block title="Use with an AI agent" description="Agents like Claude Code, Codex and Cursor can find, read and edit your notes, draw on your canvases and use everything else in Etude through MCP. Changes show up live in pages you have open.">
        <AgentSetup cmd={cmd} />
      </Block>
      <Block
        title="Logs"
        description="What the app and its engine wrote down. Attach them when you report a problem."
        stackAside
        aside={
          <Button variant="outline" size="sm" className="phone:h-10 gap-1.5 h-8" onClick={() => void app.showLogs()}>
            <FolderOpen className="size-4" />
            Show logs
          </Button>
        }
      />
    </Section>
  );
}

/** Web pages in Notebook tabs: where links open, and what the address bar searches with. */
function WebBlocks() {
  useWebSettings();
  return (
    <>
      <Block
        title="Open links in Etude"
        description="A link you click in a chat or a page opens as a web tab beside it, to check a source without leaving. Shift-click opens it in your browser."
        aside={<BigSwitch id="web-links" checked={linksInTabs()} onCheckedChange={setLinksInTabs} aria-label="Open links in Etude" />}
      />
      <Block
        title="Search with"
        description="What a web tab's address bar searches with when you type words instead of an address."
        stackAside
        aside={
          <Select value={searchEngine()} onValueChange={(v) => setSearchEngine(v as SearchEngine)}>
            <SelectTrigger className="phone:h-10 h-8 w-44" aria-label="Search engine">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(SEARCH_ENGINES) as SearchEngine[]).map((k) => (
                <SelectItem key={k} value={k}>
                  {SEARCH_ENGINES[k].name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
    </>
  );
}
