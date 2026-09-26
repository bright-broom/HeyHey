import { operatorInfo } from "@/server/lib/operator";

/** 運営者名・問い合わせ先。未設定なら、公開前に気づけるよう「未設定」と目立たせて出す */
export function OperatorName() {
  const { name } = operatorInfo();
  return name ? <>{name}</> : <Unset label="運営者名（OPERATOR_NAME）" />;
}

export function ContactEmail() {
  const { contactEmail } = operatorInfo();
  return contactEmail ? <a href={`mailto:${contactEmail}`} className="btn-link">{contactEmail}</a> : <Unset label="問い合わせ先（CONTACT_EMAIL）" />;
}

function Unset({ label }: { label: string }) {
  return <span className="border border-danger px-1 text-danger">未設定：{label}</span>;
}
