/**
 * Technology logos for stack lists ("TypeScript 5 (strict)", "better-sqlite3 ^12", ...).
 * Logos come from simple-icons (CC0); only the ones listed here are bundled.
 */
import {
  siAngular, siAstro, siBun, siCss, siCypress, siDeno, siDjango, siDocker, siDotnet, siDrizzle, siEsbuild, siEslint, siExpress,
  siFastapi, siFastify, siFirebase, siFlask, siGithubactions, siGo, siGraphql, siHono, siHtml5, siJavascript, siJest, siKotlin,
  siKubernetes, siLaravel, siMocha, siMongodb, siMysql, siNestjs, siNextdotjs, siNginx, siNodedotjs, siNpm, siNuxt, siOpenjdk,
  siPhp, siPnpm, siPostgresql, siPrettier, siPrisma, siPytest, siPython, siReact, siRedis, siRemix, siRuby, siRubyonrails, siRust,
  siSqlite, siStorybook, siStripe, siSupabase, siSvelte, siSwift, siTailwindcss, siTerraform, siTurborepo, siTypescript, siVercel,
  siVite, siVitest, siVuedotjs, siWebpack, siYarn, siZod,
  type SimpleIcon,
} from "simple-icons";

type Tech = { id: string; name: string; re: RegExp; icon: SimpleIcon };

// Order matters only for display; every match in a string is shown.
const TECHS: Tech[] = [
  { id: "ts", name: "TypeScript", re: /typescript|\bts\b|\btsc\b/i, icon: siTypescript },
  { id: "js", name: "JavaScript", re: /javascript|(?<![.\w])js\b/i, icon: siJavascript },
  { id: "node", name: "Node.js", re: /\bnode(\.js|js)?\b/i, icon: siNodedotjs },
  { id: "bun", name: "Bun", re: /\bbun\b/i, icon: siBun },
  { id: "deno", name: "Deno", re: /\bdeno\b/i, icon: siDeno },
  { id: "react", name: "React", re: /\breact\b/i, icon: siReact },
  { id: "next", name: "Next.js", re: /\bnext(\.js|js)\b/i, icon: siNextdotjs },
  { id: "remix", name: "Remix", re: /\bremix\b/i, icon: siRemix },
  { id: "vue", name: "Vue", re: /\bvue(\.js)?\b/i, icon: siVuedotjs },
  { id: "nuxt", name: "Nuxt", re: /\bnuxt\b/i, icon: siNuxt },
  { id: "svelte", name: "Svelte", re: /\bsvelte(kit)?\b/i, icon: siSvelte },
  { id: "angular", name: "Angular", re: /\bangular\b/i, icon: siAngular },
  { id: "astro", name: "Astro", re: /\bastro\b/i, icon: siAstro },
  { id: "express", name: "Express", re: /\bexpress\b/i, icon: siExpress },
  { id: "fastify", name: "Fastify", re: /\bfastify\b/i, icon: siFastify },
  { id: "hono", name: "Hono", re: /\bhono\b/i, icon: siHono },
  { id: "nest", name: "NestJS", re: /\bnest(js)?\b/i, icon: siNestjs },
  { id: "html", name: "HTML", re: /\bhtml5?\b/i, icon: siHtml5 },
  { id: "css", name: "CSS", re: /\bcss3?\b/i, icon: siCss },
  { id: "tailwind", name: "Tailwind", re: /tailwind/i, icon: siTailwindcss },
  { id: "vite", name: "Vite", re: /\bvite\b/i, icon: siVite },
  { id: "webpack", name: "webpack", re: /\bwebpack\b/i, icon: siWebpack },
  { id: "esbuild", name: "esbuild", re: /\besbuild\b/i, icon: siEsbuild },
  { id: "turbo", name: "Turborepo", re: /\bturbo(repo)?\b/i, icon: siTurborepo },
  { id: "vitest", name: "Vitest", re: /\bvitest\b/i, icon: siVitest },
  { id: "jest", name: "Jest", re: /\bjest\b/i, icon: siJest },
  { id: "mocha", name: "Mocha", re: /\bmocha\b/i, icon: siMocha },
  { id: "cypress", name: "Cypress", re: /\bcypress\b/i, icon: siCypress },
  { id: "storybook", name: "Storybook", re: /\bstorybook\b/i, icon: siStorybook },
  { id: "eslint", name: "ESLint", re: /\beslint\b/i, icon: siEslint },
  { id: "prettier", name: "Prettier", re: /\bprettier\b/i, icon: siPrettier },
  { id: "zod", name: "Zod", re: /\bzod\b/i, icon: siZod },
  { id: "graphql", name: "GraphQL", re: /\bgraphql\b/i, icon: siGraphql },
  { id: "sqlite", name: "SQLite", re: /sqlite/i, icon: siSqlite },
  { id: "postgres", name: "PostgreSQL", re: /postgres/i, icon: siPostgresql },
  { id: "mysql", name: "MySQL", re: /\bmysql\b/i, icon: siMysql },
  { id: "mongo", name: "MongoDB", re: /\bmongo(db)?\b/i, icon: siMongodb },
  { id: "redis", name: "Redis", re: /\bredis\b/i, icon: siRedis },
  { id: "prisma", name: "Prisma", re: /\bprisma\b/i, icon: siPrisma },
  { id: "drizzle", name: "Drizzle", re: /\bdrizzle\b/i, icon: siDrizzle },
  { id: "supabase", name: "Supabase", re: /\bsupabase\b/i, icon: siSupabase },
  { id: "firebase", name: "Firebase", re: /\bfirebase\b/i, icon: siFirebase },
  { id: "stripe", name: "Stripe", re: /\bstripe\b/i, icon: siStripe },
  { id: "pnpm", name: "pnpm", re: /\bpnpm\b/i, icon: siPnpm },
  { id: "yarn", name: "Yarn", re: /\byarn\b/i, icon: siYarn },
  { id: "npm", name: "npm", re: /(^|[^p])\bnpm\b/i, icon: siNpm },
  { id: "python", name: "Python", re: /\bpython\b/i, icon: siPython },
  { id: "django", name: "Django", re: /\bdjango\b/i, icon: siDjango },
  { id: "flask", name: "Flask", re: /\bflask\b/i, icon: siFlask },
  { id: "fastapi", name: "FastAPI", re: /\bfastapi\b/i, icon: siFastapi },
  { id: "pytest", name: "pytest", re: /\bpytest\b/i, icon: siPytest },
  { id: "go", name: "Go", re: /\bgolang\b|^go\b/i, icon: siGo },
  { id: "rust", name: "Rust", re: /\brust\b|\bcargo\b/i, icon: siRust },
  { id: "java", name: "Java", re: /\bjava\b|\bjvm\b/i, icon: siOpenjdk },
  { id: "kotlin", name: "Kotlin", re: /\bkotlin\b/i, icon: siKotlin },
  { id: "swift", name: "Swift", re: /\bswift(ui)?\b/i, icon: siSwift },
  { id: "dotnet", name: ".NET", re: /\.net\b|\bc#/i, icon: siDotnet },
  { id: "php", name: "PHP", re: /\bphp\b/i, icon: siPhp },
  { id: "laravel", name: "Laravel", re: /\blaravel\b/i, icon: siLaravel },
  { id: "ruby", name: "Ruby", re: /\bruby\b/i, icon: siRuby },
  { id: "rails", name: "Rails", re: /\brails\b/i, icon: siRubyonrails },
  { id: "docker", name: "Docker", re: /\bdocker\b/i, icon: siDocker },
  { id: "k8s", name: "Kubernetes", re: /\bkubernetes\b|\bk8s\b/i, icon: siKubernetes },
  { id: "terraform", name: "Terraform", re: /\bterraform\b/i, icon: siTerraform },
  { id: "nginx", name: "nginx", re: /\bnginx\b/i, icon: siNginx },
  { id: "gha", name: "GitHub Actions", re: /github actions|\bgha\b|\bci\b/i, icon: siGithubactions },
  { id: "vercel", name: "Vercel", re: /\bvercel\b/i, icon: siVercel },
];

/** Brand colour, lifted when it would disappear on the black background. */
function logoColor(hex: string) {
  const n = parseInt(hex, 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return lum < 0.28 ? "#e4e4e7" : `#${hex}`;
}

export type TechHit = { tech: Tech; version: string | null };

/** Technologies mentioned in one stack line, each with the version right after its name (if any). */
export function techsIn(line: string): TechHit[] {
  const hits: (TechHit & { at: number })[] = [];
  for (const tech of TECHS) {
    const m = tech.re.exec(line);
    if (!m) continue;
    // Skip the rest of the word first ("sqlite3" is a name, not version 3), then read "5", "^12", ">=22.11", "@3".
    const after = line.slice(m.index + m[0].length, m.index + m[0].length + 30).replace(/^[\w.-]*/, "");
    const compound = line[m.index + m[0].length] === "-"; // "typescript-eslint 8" is another package's version
    const v = compound ? null : /^\s*@?\s*((?:\^|>=|~|v)?\d+(?:\.\d+){0,2})/.exec(after)?.[1] ?? null;
    hits.push({ tech, version: v, at: m.index });
  }
  return hits.sort((a, b) => a.at - b.at);
}

export function TechLogo({ icon, size = 16 }: { icon: SimpleIcon; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className="tech-logo">
      <path d={icon.path} fill={logoColor(icon.hex)} />
    </svg>
  );
}

export function TechChip({ hit }: { hit: TechHit }) {
  return (
    <span className="tech-chip" title={hit.tech.icon.title}>
      <TechLogo icon={hit.tech.icon} />
      <span>{hit.tech.name}</span>
      {hit.version && <span className="tech-ver">{hit.version.replace(/^v/, "")}</span>}
    </span>
  );
}

/**
 * A stack as logos. Lines that name no known technology stay as short text chips
 * (parenthesised detail dropped; the full line is in the tooltip).
 */
export function StackRow({ items, extra = [] }: { items: string[]; extra?: string[] }) {
  const seen = new Set<string>();
  const chips: React.ReactNode[] = [];
  for (const line of [...items, ...extra]) {
    const hits = techsIn(line).filter((h) => !seen.has(h.tech.id));
    hits.forEach((h) => seen.add(h.tech.id));
    if (hits.length) hits.forEach((h) => chips.push(<TechChip key={h.tech.id} hit={h} />));
    else if (!techsIn(line).length) {
      const short = line.replace(/\s*\(.*?\)\s*/g, " ").trim();
      chips.push(<span key={line} className="tech-chip plain" title={line}>{short.length > 28 ? `${short.slice(0, 27)}…` : short}</span>);
    }
  }
  return <div className="tech-row">{chips}</div>;
}

