"use client";

import SignupForm from "@/components/auth/SignupForm";

export default function SignupPage() {
  return (
    <main className="min-h-screen flex items-center justify-center bg-gradient-to-br from-gray-50 to-gray-100 px-4 py-10">
      <SignupForm
        redirect="/samples"
        loginHref="/login"
      />
    </main>
  );
}
