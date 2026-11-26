// Who you're talking to in Ask: the round picture of an agent profile, and the switcher that opens from it
// (the side panel's header and the mini chat). Picking another profile starts a new chat with it.
import { useRef, useState } from "react";
import { ChevronDown, Settings2 } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandGroup, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command";
import { EPSILON_PATH } from "@/components/logo";
import { useMinimiFace } from "@/lib/minimi-face";
import { useFunMode } from "@/lib/fun";
import { EtudeImg } from "@/lib/local-url";
import { navigate } from "@/lib/router";
import { mediaUrl, MINIMI_PROFILE_ID, useAgentProfiles, type ProfileView } from "@/lib/agent-profiles";
import { cn } from "@/lib/utils";

/** Settings → AI → Agents. */
export function openAgentSettings() {
  navigate("/settings#ai-agents");
}

/** A profile's round picture: Minimi's face (the ε when Fun mode is off), a picture from the media, or the name's first letter. */
export function AgentAvatar({ profile, size = 34, className }: { profile: Pick<ProfileView, "id" | "name" | "avatar">; size?: number; className?: string }) {
  const fun = useFunMode();
  const face = useMinimiFace();
  const box = cn("shrink-0 rounded-full", className);
  const style = { width: size, height: size };
  if (profile.avatar === "minimi" && (fun || profile.id !== MINIMI_PROFILE_ID))
    return <img src={face} alt="" data-agent-avatar={profile.id} className={cn(box, "bg-card object-cover shadow-[inset_0_0_0_1px_var(--border),0_2px_6px_rgb(0_0_0/0.06)]")} style={{ ...style, objectPosition: "50% 20%" }} />;
  if (profile.avatar === "minimi")
    return (
      <span data-agent-avatar={profile.id} className={cn(box, "grid place-items-center bg-foreground")} style={style}>
        <svg viewBox="0 0 24 24" aria-hidden="true" style={{ width: size * 0.56, height: size * 0.56 }}>
          <path d={EPSILON_PATH} className="fill-background" transform="translate(2.324 21.144) scale(0.04253 -0.04253)" />
        </svg>
      </span>
    );
  if (profile.avatar) return <EtudeImg src={mediaUrl(profile.avatar)} alt="" data-agent-avatar={profile.id} draggable={false} className={cn(box, "bg-muted object-cover shadow-[inset_0_0_0_1px_var(--border)]")} style={style} />;
  return (
    <span data-agent-avatar={profile.id} aria-hidden="true" className={cn(box, "grid place-items-center bg-muted font-semibold text-foreground shadow-[inset_0_0_0_1px_var(--border)] select-none")} style={{ ...style, fontSize: size * 0.44 }}>
      {[...profile.name.trim()][0]?.toUpperCase() ?? "?"}
    </span>
  );
}

/** The avatar and name at the top of a chat; a click lists the profiles, and picking one starts a chat with it. */
export function AgentSwitcher({ current, onPick, disabled, className, compact, avatar = true }: { current: ProfileView; onPick(id: string): void; disabled?: boolean; className?: string; compact?: boolean; avatar?: boolean }) {
  const [open, setOpen] = useState(false);
  // No row is highlighted until the pointer or the arrow keys move: the current one is marked by its colour only.
  const [moved, setMoved] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const { profiles } = useAgentProfiles();
  return (
    <Popover open={open} onOpenChange={(o) => (setOpen(o), setMoved(false))}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={`Talking to ${current.name}. Change who you talk to`}
          data-agent-switcher
          data-bare={avatar ? undefined : ""}
          className={cn("mchat-round flex h-9 max-w-[11rem] min-w-0 shrink-0 items-center gap-1.5 rounded-full pr-2.5 text-sm font-semibold transition-colors outline-ring focus-visible:outline-2 disabled:opacity-60 data-[state=open]:bg-accent", avatar ? "pl-1" : "pl-3", className)}
        >
          {avatar && <AgentAvatar profile={current} size={28} />}
          {(!compact || !avatar) && <span className="truncate">{current.name}</span>}
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="w-[min(17rem,calc(100vw-1.5rem))] overflow-hidden rounded-xl p-0"
        data-agent-switcher-list
        // The arrow keys and Enter work at once: focus goes to the list, not the popover around it.
        onOpenAutoFocus={(e) => (e.preventDefault(), list.current?.focus())}
      >
        <Command ref={list} tabIndex={-1} loop onPointerMove={() => setMoved(true)} onKeyDown={() => setMoved(true)} className={cn("outline-none", !moved && "[&_[cmdk-item][data-selected=true]]:bg-transparent")}>
          <CommandList className="max-h-80">
            <CommandGroup heading="Talk to">
              {profiles.map((p) => {
                const on = p.id === current.id;
                return (
                  <CommandItem
                    key={p.id}
                    value={p.id}
                    disabled={!p.available}
                    data-profile={p.id}
                    aria-current={on ? "true" : undefined}
                    onSelect={() => {
                      setOpen(false);
                      if (!on) onPick(p.id);
                    }}
                    className="gap-2.5 py-1.5"
                  >
                    <AgentAvatar profile={p} size={26} className={cn(!p.available && "opacity-50")} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className={cn("truncate text-sm", on ? "font-semibold text-highlight" : "text-foreground", !p.available && "text-muted-foreground")}>{p.name}</span>
                      {!p.available && p.note && <span className="truncate text-[11.5px] leading-tight text-muted-foreground">{p.note}</span>}
                    </span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup>
              <CommandItem
                value="edit-agents"
                onSelect={() => {
                  setOpen(false);
                  openAgentSettings();
                }}
                className="gap-2.5 text-muted-foreground"
              >
                <Settings2 className="size-4" />
                Edit agents…
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
