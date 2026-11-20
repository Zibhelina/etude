import { EtudeImg } from "@/lib/local-url";
import { OfficialSeal } from "@/components/market-official";

/**
 * A Market cover with the entry's name set on its dark left side, as the Featured card does. The covers leave that
 * side dark for the title, so a cover shown without it reads as an empty gap. Sizes follow the cover's own width.
 */
export function TitledCover({ src, eyebrow, name, official, local = true }: { src: string; eyebrow: string; name: string; official?: boolean; local?: boolean }) {
  return (
    <div className="mk-tcover">
      {local ? <EtudeImg src={src} alt="" loading="lazy" /> : <img src={src} alt="" loading="lazy" />}
      <div className="mk-tcover-text" aria-hidden="true">
        <div className="mk-tcover-eyebrow">{eyebrow}</div>
        <div className="mk-serif mk-tcover-name">{name}{official && <OfficialSeal size={18} className="mk-seal-title" />}</div>
      </div>
    </div>
  );
}
