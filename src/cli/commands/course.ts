import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { checkCourse, courseHash, coursesFor, loadCourseSource } from "../../core/courses.ts";
import { command, group, CliError } from "../registry.ts";

group({ name: "course", summary: "Courses: interactive HTML courses (plain HTML or Course Kit) in your Library", defaultVerb: "list" });

command({
  name: "course list",
  summary: "Installed courses and their progress.",
  examples: ["etude course list"],
  output: "array of installed courses with manifest metadata and progress",
  run: (ctx) => coursesFor(ctx.e).list(),
});

command({
  name: "course show",
  summary: "Details, outline and progress of one installed course.",
  args: [{ name: "id", description: "Course id.", required: true }],
  examples: ["etude course show intro-networking"],
  output: "installed course metadata and progress",
  run(ctx) {
    const c = coursesFor(ctx.e).get(ctx.args.id);
    if (!c) throw new CliError(`unknown course "${ctx.args.id}"`, "not_found");
    return c;
  },
});

command({
  name: "course check",
  summary: "Validate a course folder, .html file, or course/1 JSON package.",
  args: [{ name: "source", description: "Course folder, .html file, or .json package.", required: true }],
  noDb: true,
  examples: ["etude course check ./my-course", "etude course check ./my-course.html"],
  output: "{ ok, id, name, version, lessons, hash, errors }",
  run(ctx) {
    const pkg = loadCourseSource(ctx.args.source);
    const errors = checkCourse(pkg);
    return {
      ok: errors.length === 0,
      id: pkg.manifest.id,
      name: pkg.manifest.name,
      version: pkg.manifest.version,
      lessons: pkg.manifest.lessons?.length ?? 0,
      hash: errors.length === 0 ? courseHash(pkg) : null,
      errors,
    };
  },
});

command({
  name: "course import",
  summary: "Import a course from a folder (course.json + index.html), a standalone .html file, or a course/1 JSON file.",
  args: [{ name: "source", description: "Course folder, .html file, or .json package.", required: true }],
  flags: [
    { name: "id", type: "string", description: "Override the course slug id.", placeholder: "SLUG" },
    { name: "name", type: "string", description: "Override the course title." },
    { name: "subtitle", type: "string", description: "Override the course subtitle." },
    { name: "description", type: "string", description: "Override the course description." },
    { name: "author", type: "string", description: "Override the author name." },
    { name: "version", type: "string", description: "Override the version." },
    { name: "icon", type: "string", description: "Emoji icon shown in Library." },
  ],
  writes: true,
  dryRun: true,
  examples: ["etude course import ./my-course", "etude course import ./intro.html --name 'Intro to DSP'"],
  output: "{ course, status: installed|updated|unchanged }",
  run(ctx) {
    const pkg = loadCourseSource(ctx.args.source, {
      id: ctx.flags.id,
      name: ctx.flags.name,
      subtitle: ctx.flags.subtitle,
      description: ctx.flags.description,
      author: ctx.flags.author,
      version: ctx.flags.version,
      icon: ctx.flags.icon,
    });
    if (ctx.dry) {
      const errors = checkCourse(pkg);
      if (errors.length) throw new CliError(`invalid course: ${errors.join("; ")}`, "usage");
      return { dryRun: true, id: pkg.manifest.id, name: pkg.manifest.name, lessons: pkg.manifest.lessons?.length ?? 0, hash: courseHash(pkg) };
    }
    return coursesFor(ctx.e).install(pkg, { source: "local" });
  },
});

command({
  name: "course export",
  summary: "Export an installed course as a course/1 JSON package.",
  args: [{ name: "id", description: "Course id.", required: true }],
  flags: [
    { name: "out", type: "string", short: "o", description: "Write the package to this file instead of stdout.", placeholder: "FILE" },
    { name: "force", type: "boolean", description: "Overwrite an existing --out file." },
  ],
  examples: ["etude course export intro-networking -o intro-networking.course.json"],
  output: "{ manifest, html } or { written, id, bytes } with --out",
  run(ctx) {
    const pkg = coursesFor(ctx.e).packageOf(ctx.args.id);
    if (!pkg) throw new CliError(`unknown course "${ctx.args.id}"`, "not_found");
    const out = { manifest: pkg.manifest, html: pkg.html };
    if (ctx.flags.out) {
      const dest = resolve(ctx.flags.out);
      if (existsSync(dest) && !ctx.flags.force) throw new CliError(`${dest} exists (use --force)`, "conflict");
      const json = JSON.stringify(out, null, 2) + "\n";
      writeFileSync(dest, json);
      return { written: dest, id: pkg.manifest.id, bytes: Buffer.byteLength(json, "utf8") };
    }
    return out;
  },
});

command({
  name: "course reset",
  summary: "Reset saved progress for an installed course.",
  args: [{ name: "id", description: "Course id.", required: true }],
  writes: true,
  confirm: true,
  examples: ["etude course reset intro-networking --yes"],
  run: (ctx) => coursesFor(ctx.e).resetProgress(ctx.args.id),
});

command({
  name: "course remove",
  summary: "Remove an installed course and its progress from your Library.",
  args: [{ name: "id", description: "Course id.", required: true }],
  writes: true,
  confirm: true,
  examples: ["etude course remove intro-networking --yes"],
  run: (ctx) => coursesFor(ctx.e).remove(ctx.args.id),
});
