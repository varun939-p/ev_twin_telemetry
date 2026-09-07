"use client";

import type { ReactNode } from "react";

import Modal from "@/components/ui/Modal";

export interface DetailField {
  label: string;
  value: ReactNode;
}

export default function DraftDetailModal({
  open,
  onClose,
  title,
  subtitle,
  fields,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  fields: DetailField[];
  children?: ReactNode;
}) {
  return (
    <Modal open={open} onClose={onClose} title={title} subtitle={subtitle} widthClass="max-w-2xl">
      <div className="p-5">
        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {fields.map((field) => (
            <div key={field.label} className="rounded-lg border border-line bg-surface-2 p-3">
              <dt className="text-[10px] font-semibold text-ink-3">{field.label}</dt>
              <dd className="num mt-1 text-[13px] font-semibold text-ink">{field.value}</dd>
            </div>
          ))}
        </dl>
        {children}
      </div>
    </Modal>
  );
}
