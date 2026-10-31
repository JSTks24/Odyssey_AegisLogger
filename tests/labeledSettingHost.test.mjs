import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

import { JsxEmit, ModuleKind, transpileModule } from "typescript";

const host = process.env.VENCORD_DIR;
assert.ok(host, "Set VENCORD_DIR to the Vencord checkout under test.");

const React = {
    createElement(type, props, ...children) {
        const attributes = { ...props, children: children.flat().filter(child => child != null && child !== false) };
        return typeof type === "function" ? type(attributes) : { type, props: attributes };
    }
};
const dependencies = {
    "./Text.css": {},
    "@utils/css": { classNameFactory: prefix => (...names) => names.filter(Boolean).map(name => prefix + name).join(" ") },
    "@utils/misc": { classes: (...names) => names.filter(Boolean).join(" ") }
};

function load(path) {
    const { outputText } = transpileModule(readFileSync(path, "utf8"), {
        fileName: String(path),
        compilerOptions: { module: ModuleKind.CommonJS, jsx: JsxEmit.React }
    });
    const exports = {};
    runInNewContext(outputText, {
        exports,
        React,
        require(name) {
            assert.ok(Object.hasOwn(dependencies, name), "Unexpected host dependency: " + name);
            return dependencies[name];
        }
    });
    return exports;
}

dependencies["@components/Text"] = load(resolve(host, "src/components/Text.tsx"));
const { LabeledSetting, labeled } = load(new URL("../components/settings/LabeledSetting.tsx", import.meta.url));

test("renders setting labels with the current host Text component and original typography", () => {
    const child = { type: "input", props: {} };
    const tree = LabeledSetting({ option: { displayName: "Title", description: "Details" }, children: child });
    const [title, description] = tree.props.children[0].props.children;
    assert.equal(title.props.children[0], "Title");
    assert.match(title.props.className, /vc-text-md vc-text-medium/);
    assert.equal(description.props.children[0], "Details");
    assert.match(description.props.className, /vc-text-sm vc-text-normal/);
    assert.equal(title.props.variant, undefined);
    assert.equal(description.props.variant, undefined);
    assert.equal(tree.props.children[1], child);
});

test("keeps unlabeled controls and omits absent descriptions", () => {
    const child = { type: "input", props: {} };
    const tree = LabeledSetting({ children: child });
    assert.equal(tree.props.children.length, 1);
    assert.equal(tree.props.children[0], child);
    const named = labeled(() => child)({ option: { displayName: "Title" } });
    assert.equal(named.props.children[0].props.children.length, 1);
    assert.equal(named.props.children[1], child);
});
