import type { Metadata } from "next";
import type { ReactNode } from "react";
import Script from "next/script";
import "./globals.css";

export const metadata: Metadata = {
  title: "Hold'em Mini — Play Money Poker",
  description:
    "A Telegram Mini App Texas Hold'em game played with virtual coins. No real money, not gambling.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* Telegram WebApp SDK: defines window.Telegram.WebApp used by the
            client telegram wrapper. Loads before the app becomes interactive. */}
        <Script
          src="https://telegram.org/js/telegram-web-app.js"
          strategy="beforeInteractive"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
