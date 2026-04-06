import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Analyzátor poplatků | Zjisti, kolik tě stojí tvůj fond",
  description:
    "Nahraj smlouvu od Conseq, Amundi nebo jiného fondu a zjisti, kolik skutečně platíš na poplatcích.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="cs">
      <body className={`${inter.className} bg-gray-50 min-h-screen`}>
        <header className="bg-white border-b border-gray-200">
          <div className="max-w-5xl mx-auto px-4 py-4 flex items-center gap-3">
            <a href="/" className="flex items-center gap-3 hover:opacity-80 transition-opacity">
              <div className="w-8 h-8 bg-green-600 rounded-lg flex items-center justify-center text-white font-bold text-sm">
                P
              </div>
              <span className="font-semibold text-gray-900">Analyzátor poplatků</span>
            </a>
            <span className="ml-auto text-xs text-gray-400">Beta verze — zdarma</span>
          </div>
        </header>
        <main className="max-w-5xl mx-auto px-4 py-8">{children}</main>
        <footer className="mt-16 border-t border-gray-200 py-8 text-center text-sm text-gray-400">
          Tento nástroj slouží pouze k informačním účelům. Neposkytuje finanční poradenství.
        </footer>
      </body>
    </html>
  );
}
