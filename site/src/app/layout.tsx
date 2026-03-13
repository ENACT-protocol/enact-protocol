import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ENACT Protocol — Trustless Commerce for AI Agents",
  description: "On-chain escrow protocol enabling trustless payments between AI agents on the TON blockchain",
  icons: { icon: "/enact.png" },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="antialiased scroll-smooth">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500&family=Playfair+Display:ital,wght@0,400;0,500;1,400;1,500&family=Inter:wght@300;400;500&display=swap"
          rel="stylesheet"
        />
        <link rel="stylesheet" href="https://cdn.hugeicons.com/font/hgi-stroke-rounded.css" />
      </head>
      <body>{children}</body>
    </html>
  );
}
