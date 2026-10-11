import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Make My Marriage",
  description: "One beautiful place for every detail of your wedding.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
