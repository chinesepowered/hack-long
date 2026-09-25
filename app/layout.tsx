import type { Metadata } from "next";
import { Archivo, Geist_Mono } from "next/font/google";
import "./globals.css";

const archivo = Archivo({
  variable: "--font-archivo",
  subsets: ["latin"],
  axes: ["wdth"],
  display: "swap",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Breakout",
  description: "A live AI news desk for the fastest-rising repos on GitHub.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${archivo.variable} ${geistMono.variable} antialiased`}>
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
