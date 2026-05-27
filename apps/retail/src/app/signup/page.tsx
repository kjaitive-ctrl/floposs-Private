"use client";

import SignupForm from "@/components/auth/SignupForm";

export default function SignupPage() {
  return (
    <main className="min-h-screen flex items-center justify-center bg-gradient-to-br from-gray-50 to-gray-100 px-4 py-10">
      <SignupForm
        redirect="/samples"
        loginHref="/login"
        subtitle="한 번 가입하면 모든 도매에 주문할 수 있어요"
      />
    </main>
  );
}
