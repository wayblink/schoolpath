"use client";

import { ArrowLeft } from "lucide-react";
import { useRouter } from "next/navigation";

export function BackButton({ fallback = "/schools" }: { fallback?: string }) {
  const router = useRouter();

  function goBack() {
    if (window.history.length > 1) {
      router.back();
      return;
    }
    router.push(fallback);
  }

  return (
    <button type="button" className="school-detail-back" onClick={goBack}>
      <ArrowLeft aria-hidden="true" size={16} strokeWidth={2.2} />
      <span>返回上一页</span>
    </button>
  );
}
