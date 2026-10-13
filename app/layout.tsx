import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Suspense } from "react";
import { AccountMenu, AccountMenuFallback } from "@/components/account-menu";
import { SiteHeader } from "@/components/site-header";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "Recall — read long series, never lose the plot",
    template: "%s · Recall",
  },
  description:
    "Recall tracks your progress through light novels and long book series, and lets you ask spoiler-safe questions about what you've already read.",
};

// Applies a saved theme before first paint to avoid a flash.
const themeScript = `try{var t=localStorage.getItem('theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-full flex flex-col">
        <Suspense fallback={<div className="h-16 border-b border-border" aria-hidden />}>
          <SiteHeader
            account={
              <Suspense fallback={<AccountMenuFallback />}>
                <AccountMenu />
              </Suspense>
            }
          />
        </Suspense>
        <main className="flex-1">{children}</main>
      </body>
    </html>
  );
}
