import Link from "next/link";

const sections = [
  {
    href: "/four-floating-blocks",
    label: "Four floating glass blocks (based on section seven)",
  },
  {
    href: "/compass-pattern",
    label: "A grid of arrows that point toward your cursor like compass needles",
  },
  {
    href: "/compass-pattern-2",
    label: "A big arrow that spins to your cursor; the ring quarter it points at lights orange",
  },
  // {
  //   href: "/section-seven",
  //   label: "Clear glass bar that splits, swirls into a ring, and grows as you scroll",
  // },
  // {
  //   href: "/section-six",
  //   label: "Frosted glass ring with segments you can grab and spin",
  // },
  // {
  //   href: "/line-grid",
  //   label: "A grid of little lines that turn to follow your cursor",
  // },
  // {
  //   href: "/section-five",
  //   label: "Frosted glass bar morphing into a hollow ring",
  // },
  // {
  //   href: "/section-four",
  //   label: "Orange glass blocks tumbling down into a stack",
  // },
  // {
  //   href: "/section-three",
  //   label: "Orange glass slabs rippling in a wave",
  // },
  // {
  //   href: "/section-two",
  //   label: "Orange glass block filled with liquid, slowly rotating",
  // },
];

export default function Home() {
  return (
    <main className="min-h-screen flex items-center justify-center p-8">
      <nav className="w-full max-w-lg">
        <h1 className="mb-8 font-mono text-xs uppercase tracking-widest opacity-50">
          Sections
        </h1>
        <ul className="flex flex-col">
          {sections.map(({ href, label }) => (
            <li key={href}>
              <Link
                href={href}
                className="flex flex-col gap-1 border-b border-current/10 py-4 transition-opacity hover:opacity-60"
              >
                <span className="text-xl leading-snug">{label}</span>
                <span className="font-mono text-xs opacity-40">{href}</span>
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </main>
  );
}
