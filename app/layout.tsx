import "./globals.css";

export const metadata = {
  title: "Rajeev AI",
  description: "Your thinking partner.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
