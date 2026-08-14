import Link from "next/link";
import { LineChart, Coins, Settings } from "lucide-react";

export default function Sidebar() {
  return (
    <aside className="w-60 bg-[#101014] border-r border-gray-800 p-4 flex flex-col">
      <div className="text-xl font-semibold mb-8">⚡ Dashboard</div>

      <nav className="flex flex-col gap-3 text-gray-400">
        <Link
          href="/trading"
          className="flex items-center gap-2 hover:text-white transition"
        >
          <LineChart size={16} /> Trading
        </Link>
        <Link
          href="/portfolio"
          className="flex items-center gap-2 hover:text-white transition"
        >
          <Coins size={16} /> Portfolio
        </Link>
        <Link
          href="/settings"
          className="flex items-center gap-2 hover:text-white transition"
        >
          <Settings size={16} /> Settings
        </Link>
      </nav>
    </aside>
  );
}
