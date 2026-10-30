// Settings → Desktop app, shown only inside the desktop app: the etude command and the logs. Its
// updates are under About, like everywhere else.
import { useEffect, useState } from "react";
import { Check, FolderOpen, Loader2, Terminal } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Block, Section } from "@/components/settings-ui";
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
            <Button variant="outline" size="sm" className="h-10 gap-1.5 md:h-8" disabled={busy} onClick={install}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Terminal className="size-4" />}
              Install the etude command
            </Button>
          ) : undefined
        }
      >
        <CommandStatus cmd={cmd} />
      </Block>
      <Block
        title="Logs"
        description="What the app and its engine wrote down. Attach them when you report a problem."
        stackAside
        aside={
          <Button variant="outline" size="sm" className="h-10 gap-1.5 md:h-8" onClick={() => void app.showLogs()}>
            <FolderOpen className="size-4" />
            Show logs
          </Button>
        }
      />
    </Section>
  );
}
