/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { User } from "@vencord/discord-types";
import { MessageStore } from "@webpack/common";

import { LoggedMessageJSON, RefrencedMessage } from "../types";
import messageEmbeds from "./messageEmbeds";
import { getGuildIdByChannel, isGhostPinged } from "./misc";

export function cleanupMessage(message: any, removeDetails: boolean = true): LoggedMessageJSON {
    const ret: LoggedMessageJSON = typeof message.toJS === "function" ? JSON.parse(JSON.stringify(message.toJS())) : { ...message };
    if (removeDetails) {
        ret.author = Object.assign(
            Object.create(Object.getPrototypeOf(ret.author)),
            ret.author,
            { phone: undefined, email: undefined }
        );
    }

    ret.ghostPinged = ret.mentioned ?? isGhostPinged(message);
    ret.guildId = ret.guild_id || ret.guildId || getGuildIdByChannel(ret.channel_id);
    ret.embeds = (ret.embeds ?? []).map(cleanupEmbed);
    ret.deleted = ret.deleted ?? false;
    ret.deletedTimestamp = ret.deleted ? (new Date()).toISOString() : undefined;
    ret.editHistory = ret.editHistory ?? [];
    ret.editHistory = ret.editHistory.map(edit => edit.embeds == null ? edit : { ...edit, embeds: edit.embeds.map(messageEmbeds.normalize) });
    if (ret.type === 19) {
        ret.message_reference = message.message_reference || message.messageReference;
        if (ret.message_reference) {
            if (message.referenced_message) {
                ret.referenced_message = cleanupMessage(message.referenced_message) as RefrencedMessage;
            } else if (MessageStore.getMessage(ret.message_reference.channel_id, ret.message_reference.message_id)) {
                ret.referenced_message = cleanupMessage(MessageStore.getMessage(ret.message_reference.channel_id, ret.message_reference.message_id)) as RefrencedMessage;
            }
        }
    }

    return ret;
}

export function cleanUpCachedMessage(message: any) {
    const ret = cleanupMessage(message, false);
    ret.ourCache = true;
    return ret;
}

export function cleanupEmbed(embed) {
    return messageEmbeds.normalize(embed);
}

export function cleanupUserObject(user: User) {
    return {
        discriminator: user.discriminator,
        username: user.username,
        avatar: user.avatar,
        id: user.id,
        bot: user.bot,
        public_flags: typeof user.publicFlags !== "undefined" ? user.publicFlags : (user as any).public_flags
    };
}
