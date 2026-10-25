// An example answer for watch mode: the first accepted answer of each blank.
return (key.answers ?? []).map((alts) => String(alts?.[0] ?? ""));
