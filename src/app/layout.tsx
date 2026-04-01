import "~/styles/globals.css";

import { Metadata } from "next";
import { Bebas_Neue, Space_Grotesk } from "next/font/google";

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-sans",
});

const bebasNeue = Bebas_Neue({
  subsets: ["latin"],
  weight: "400",
  variable: "--font-display",
});

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
const metadataBase = new URL(siteUrl);
const previewImageUrl = new URL("/preview2.png", metadataBase).toString();

export const metadata: Metadata = {
  title: "CHAPTER 2 TRAILER IN...",
  description: "Countdown to the Scrap Mechanic Chapter 2 trailer.",
  metadataBase,
  icons: [{ rel: "icon", url: "/favicon.ico" }],
  openGraph: {
    title: "CHAPTER 2 TRAILER IN...",
    description: "Countdown to the Scrap Mechanic Chapter 2 trailer.",
    images: [previewImageUrl],
  },
  twitter: {
    card: "summary_large_image",
    title: "CHAPTER 2 TRAILER IN...",
    description: "Countdown to the Scrap Mechanic Chapter 2 trailer.",
    images: [previewImageUrl],
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark h-full">
      <body
        className={`${spaceGrotesk.variable} ${bebasNeue.variable} h-full font-sans antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
