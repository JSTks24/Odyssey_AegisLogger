import { vi } from "vitest";

export const ChannelStore: any = { getChannel: () => null };
export const GuildStore: any = { getGuild: () => null };
export const UserStore: any = { getCurrentUser: () => ({ id: "self" }) };
export const GuildMemberStore: any = { getMember: () => null };
export const SelectedChannelStore: any = { getChannelId: () => "" };
export const MessageStore: any = { getMessage: () => null };
export const Toasts: any = { genId: () => "id", Type: { SUCCESS: "SUCCESS", FAILURE: "FAILURE" }, show: vi.fn() };
