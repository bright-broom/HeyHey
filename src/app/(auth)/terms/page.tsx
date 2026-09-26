import { TermsBody } from "@/components/TermsBody";

export const metadata = { title: "利用規約" };

export default function TermsPage() {
  return (
    <div className="card p-6 text-sm">
      <h1 className="h1 mb-4">利用規約</h1>
      <TermsBody />
    </div>
  );
}
