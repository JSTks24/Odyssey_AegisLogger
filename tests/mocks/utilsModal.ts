import { vi } from "vitest";

export const ModalRoot = (_props: Record<string, unknown>) => ({ $$kind: "modal-root" });
export const ModalHeader = (_props: Record<string, unknown>) => ({ $$kind: "modal-header" });
export const ModalContent = (_props: Record<string, unknown>) => ({ $$kind: "modal-content" });
export const ModalFooter = (_props: Record<string, unknown>) => ({ $$kind: "modal-footer" });
export const ModalSize = { SMALL: "small", MEDIUM: "medium", LARGE: "large" } as const;
export const openModal = vi.fn();
