/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

function normalize(embed: any) {
    if (embed == null || typeof embed !== "object") return {};
    if (!embed.id) return embed;
    const media = (value: any) => value == null ? undefined : {
        url: value.url, proxy_url: value.proxy_url ?? value.proxyURL,
        width: value.width, height: value.height, description: value.description
    };
    const timestamp = embed.timestamp instanceof Date ? embed.timestamp.toISOString()
        : embed.timestamp?._isAMomentObject ? embed.timestamp.toISOString?.() ?? embed.timestamp.milliseconds?.() : embed.timestamp;
    const { thumbnail } = embed;

    return {
        type: embed.type, title: embed.rawTitle ?? embed.title, description: embed.rawDescription ?? embed.description,
        url: embed.url, color: embed.color, timestamp, reference_id: embed.referenceId,
        provider: embed.provider && { name: embed.provider.name, url: embed.provider.url },
        author: embed.author && {
            name: embed.author.name, url: embed.author.url, icon_url: embed.author.icon_url ?? embed.author.iconURL,
            proxy_icon_url: embed.author.proxy_icon_url ?? embed.author.iconProxyURL
        },
        footer: embed.footer && {
            text: embed.footer.text, icon_url: embed.footer.icon_url ?? embed.footer.iconURL,
            proxy_icon_url: embed.footer.proxy_icon_url ?? embed.footer.iconProxyURL
        },
        image: media(embed.image),
        thumbnail: thumbnail && (typeof thumbnail.proxyURL === "string" || typeof thumbnail.url === "string" && !thumbnail.url.endsWith("?format=jpeg"))
            ? { ...media(thumbnail), proxy_url: thumbnail.proxyURL?.split("?format")[0] ?? thumbnail.proxy_url } : undefined,
        video: media(embed.video),
        fields: embed.fields?.map((field: any) => ({ name: field.rawName ?? field.name, value: field.rawValue ?? field.value, inline: !!field.inline }))
    };
}

function key(embeds: unknown, richOnly = false) {
    if (!Array.isArray(embeds)) return "[]";
    return JSON.stringify(embeds.filter(embed => !richOnly || (embed?.type ?? "rich") === "rich").map(item => {
        const embed = normalize(item);
        const color = typeof embed.color === "string" && /^#[\da-f]{6}$/i.test(embed.color) ? parseInt(embed.color.slice(1), 16) : embed.color;
        return [
            embed.type ?? "rich", embed.title ?? "", embed.description ?? "", embed.url ?? "", color ?? null, embed.timestamp ?? null,
            embed.author?.name ?? "", embed.author?.url ?? "", embed.author?.icon_url ?? "",
            embed.footer?.text ?? "", embed.footer?.icon_url ?? "",
            embed.provider?.name ?? "", embed.provider?.url ?? "",
            embed.image?.url ?? "", embed.thumbnail?.url ?? "", embed.video?.url ?? "",
            embed.image?.description ?? "", embed.thumbnail?.description ?? "",
            (embed.fields ?? []).map((field: any) => [field.name ?? "", field.value ?? "", !!field.inline])
        ];
    }));
}

const messageEmbeds = { normalize, key };

export default messageEmbeds;
