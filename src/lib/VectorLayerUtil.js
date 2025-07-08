import EllipsisVectorLayerBase from "./EllipsisVectorLayerBase";

import { create, all } from "mathjs";
import { SHA256, enc } from "crypto-js";

const math = create(all);
math.import(
  {
    equal: function (a, b) {
      return a === b;
    },
  },
  { override: true }
);
math.import(
  {
    unequal: function (a, b) {
      return a !== b;
    },
  },
  { override: true }
);

const parseHex = (color, toRGB) => {
  if (!color) return;

  const splitHexComponents =
    /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})?$/i.exec(color);

  //Retreive all color components from hex
  let [r, g, b, alpha] = splitHexComponents
    .slice(1)
    .map((x) => parseInt(x, 16));
  alpha = isNaN(alpha) ? (alpha = undefined) : (alpha /= 255);

  if (toRGB) return { r, g, b, opacity: alpha };
  return {
    color: `#${splitHexComponents.slice(1, 4).join("")}`,
    opacity: alpha,
  };
};

/**
 * Parses hex color values from feature to create an object that has all styling
 * parameters merged, which does include default stylings.
 * Priority of the different places to pass styling:
 * 1) ...stylingSources
 * 2) feature.properties
 * 3) default styling
 * @param {*} feature
 * @param {*} stylingOptions
 * @returns {*}
 */
const getFeatureStyling = (feature, style, properties) => {
  const stylingProperties = {
    radius: getVectorLayerColor(properties, style, "radius"),
    weight: getVectorLayerColor(properties, style, "width"),
    opacity: style.parameters.alphaMultiplier,
    fillColor: getVectorLayerColor(properties, style, "fill"),
    fillOpacity: style.parameters.alphaMultiplier,
    color: getVectorLayerColor(properties, style, "fill"),
    popupProperty: style.parameters.popupProperty?.text,
  };
  return stylingProperties;
};

function rgbComponentToHex(rgbComp) {
  return (Math.round(rgbComp) | (1 << 8)).toString(16).slice(1);
}

function alphaToHex(alpha) {
  return (Math.round(alpha * 255) | (1 << 8)).toString(16).slice(1);
}

function hue2rgb(p, q, t) {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

function rgbHexConversion(hex) {
  let r = parseInt(hex.substring(0, 2), 16) / 255;
  let g = parseInt(hex.substring(2, 4), 16) / 255;
  let b = parseInt(hex.substring(4, 6), 16) / 255;
  let max = Math.max(r, g, b);
  let min = Math.min(r, g, b);
  let h = (max + min) / 2;
  let s = (max + min) / 2;
  let l = (max + min) / 2;

  if (max === min) {
    h = 0;
    s = 0;
  } else {
    let d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    // eslint-disable-next-line default-case
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      case b:
        h = (r - g) / d + 4;
        break;
    }
    h = h / 6;
  }

  s = 0.75 * s + 0.25; // s between 0.25 and 1
  l = 0.5 * l + 0.25; // l between 0.25 and 0.75

  if (s === 0) {
    r = l;
    g = l;
    b = l;
  } else {
    let q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    let p = 2 * l - q;

    r = 255 * hue2rgb(p, q, h + 1 / 3);
    g = 255 * hue2rgb(p, q, h);
    b = 255 * hue2rgb(p, q, h - 1 / 3);
  }

  return rgbComponentToHex(r) + rgbComponentToHex(g) + rgbComponentToHex(b);
}

const STYLE_METHOD = {
  rules: "rules",
  transitionPoints: "transitionPoints",
  random: "random",
  singleColor: "singleColor",
  fromColorProperty: "fromColorProperty",
  classToColor: "classToColor",
  formula: "formula",
  v2: "v2",
};

function getVectorLayerColorNew(properties, style, ktype) {
  let color;

  const params = style.parameters[ktype];

  switch (params.type) {
    case "constant": {
      color = params.target[params.target.type];
      break;
    }
    case "seededRandom": {
      let value = evaluateExpression(params.expressionObject, properties);
      value = value ?? "";
      let originalHex = SHA256(value.toString()).toString(enc.Hex).substr(-6);
      color =
        "#" +
        rgbHexConversion(originalHex) +
        alphaToHex(style.parameters.alpha);

      break;
    }

    case "caseMap": {
      for (let i = 0; i < params.caseMap.length; i++) {
        const c = params.caseMap[i];
        const value = evaluateExpression(c.expressionObject, properties);
        if (value) {
          color = c.target[c.target.type];
          break;
        }
      }
      if (!color) {
        color = params.defaultTarget[params.defaultTarget.type];
      }
      break;
    }
    case "rangeMap": {
      const value = evaluateExpression(params.expressionObject, properties);
      for (let i = 0; i < params.rangeMap.length; i++) {
        const t = params.rangeMap[i];
        if (value <= t.value) {
          color = t.target[t.target.type];
          break;
        }
      }
      if (!color) {
        color = params.defaultTarget[params.defaultTarget.type];
      }
      break;
    }
    case "valueMap": {
      const value = evaluateExpression(params.expressionObject, properties);
      for (let i = 0; i < params.valueMap.length; i++) {
        const t = params.valueMap[i];
        if (value === t.value) {
          color = t.target[t.target.type];
          break;
        }
      }
      if (!color) {
        color = params.defaultTarget[params.defaultTarget.type];
      }
      break;
    }
    case "expression": {
      color = evaluateExpression(params.expressionObject, properties);
      break;
    }
    default: {
      throw Error(`Received invalid fill type in style.parameters.fill.type`);
    }
  }

  if (!color) {
    if (ktype === "fill") {
      return "#f57c00";
    } else if (ktype === "width") {
      return 5;
    } else {
      return 10;
    }
  }
  if (ktype === "fill") {
    color = color.slice(0, 7);
  }
  return color;
}

export function evaluateExpression(expressionObject, properties) {
  let evaluationProperties = {};
  if (expressionObject.properties) {
    let propertyNames = expressionObject.properties;

    const propertyValues = [];
    for (let i = 0; i < propertyNames.length; i++) {
      let propertyValue = properties[propertyNames[i]];

      propertyValues.push(propertyValue);
    }

    for (let i = 0; i < propertyValues.length; i++) {
      evaluationProperties[`property${i + 1}`] = propertyValues[i];
    }
  }

  if (expressionObject.values) {
    const propertyValues = expressionObject.values;
    for (let i = 0; i < propertyValues.length; i++) {
      evaluationProperties[`value${i + 1}`] = propertyValues[i];
    }
  }

  const expression = expressionObject.expression;
  let evaluation;

  let testExpression = expression
    .replaceAll(" ", "")
    .replaceAll("!=", "NE")
    .replaceAll("||", "or")
    .replaceAll("&&", "and")
    .replaceAll("!", "not")
    .replaceAll("NE", "!=");

  try {
    evaluation = math.evaluate(testExpression, evaluationProperties);
  } catch {
    evaluation = null;
  }
  return evaluation;
}

function convertVectorStyle(style) {
  if (style.method === "v2") {
    return style;
  }

  style.parameters.alphaMultiplier = style.parameters.alpha;
  delete style.parameters.alpha;

  if (style.parameters.borderColor) {
    style.parameters.borderColor = {
      type: "constant",
      target: { type: "color", color: style.parameters.borderColor },
    };
  }

  if (style.parameters.altitude) {
    style.parameters.elevation = {
      type: "expression",
      defaultTarget: { type: "number", number: 0 },
      expressionObject: {
        properties: [style.parameters.altitude.property],
        values: [],
        expression: "property1",
      },
    };
    delete style.parameters.altitude;
  }

  style.parameters.width = {
    type: "constant",
    target: { type: "number", number: style.parameters.width },
  };

  if (style.parameters.radius?.method === "onProperty") {
    style.parameters.radius = {
      type: "expression",
      defaultTarget: { type: "number", number: 10 },
      expressionObject: {
        properties: [style.parameters.radius.parameters.property],
        values: [],
        expression: "property1",
      },
    };
  } else {
    style.parameters.radius = {
      type: "expression",
      defaultTarget: {
        type: "number",
        number: style.parameters.radius.parameters.value,
      },
      expressionObject: {
        properties: [],
        values: [],
        expression: style.parameters.radius.parameters.value.toString(),
      },
    };
  }

  if (style.parameters.popupProperty) {
    const textColor = style.parameters.textColor ?? `#000000`;
    style.parameters.popOver = {
      color: { type: "constant", target: { type: "color", color: textColor } },
      text: {
        type: "expression",
        defaultTarget: { type: "string", string: "" },
        expressionObject: {
          properties: [style.parameters.popupProperty],
          values: [],
          expression: "property1",
        },
      },
    };
    delete style.parameters.popupProperty;
  }
  //now the fill

  let defaultTarget;
  if (style.parameters.defaultColor) {
    defaultTarget = { type: "color", color: style.parameters.defaultColor };
    delete style.parameters.defaultColor;
  }

  if (style.parameters.icon) {
    defaultTarget = { type: "icon", icon: style.parameters.defaultIcon };
    delete style.parameters.defaultIcon;
  }
  if (style.parameters.pattern) {
    defaultTarget = { type: "pattern", pattern: style.parameters.pattern };
    delete style.parameters.defaultPattern;
  }

  const fetchTarget = (rule) => {
    let target;
    if (rule.color) {
      target = { type: "color", color: rule.color };
    } else if (rule.pattern) {
      target = { type: "pattern", pattern: rule.pattern };
    } else if (rule.icon) {
      target = { type: "icon", icon: rule.icon };
    }
    return target;
  };

  if (style.method === "singleColor") {
    if (style.parameters.color) {
      style.parameters.fill = {
        type: "constant",
        target: { type: "color", color: style.parameters.color },
      };
      delete style.parameters.color;
    }

    if (style.parameters.pattern) {
      style.parameters.fill = {
        type: "constant",
        target: { type: "pattern", color: style.parameters.pattern },
      };
      delete style.parameters.pattern;
    }
    if (style.parameters.icon) {
      style.parameters.fill = {
        type: "constant",
        target: { type: "icon", color: style.parameters.icon },
      };
      delete style.parameters.icon;
    }
  } else if (style.method === "fromColorProperty") {
    delete style.parameters.defaultColor;

    style.parameters.fill = {
      type: "expression",
      defaultTarget: defaultTarget,
      expressionObject: {
        properties: ["color"],
        values: [],
        expression: "property1",
      },
    };
  } else if (style.method === "rules") {
    const caseMap = style.parameters.rules.map((rule) => {
      const target = fetchTarget(rule);
      if (rule.operator === "=") {
        rule.operator = "==";
      }
      const expression = `property1 ${rule.operator} ${rule.value}`;
      return {
        target: target,
        expressionObject: {
          properties: [rule.property],
          values: [],
          expression: expression,
        },
      };
    });

    delete style.parameters.rules;
    style.parameters.fill = {
      type: "caseMap",
      defaultTarget: defaultTarget,
      caseMap: caseMap,
    };
  } else if (style.method === "random") {
    style.parameters.fill = {
      type: "seededRandom",
      expressionObject: {
        properties: [style.parameters.property],
        values: [],
        expression: "property1",
      },
    };
    delete style.parameters.property;
  } else if (style.method === "transitionPoints") {
    const rangeMap = style.parameters.transitionPoints.map((point) => {
      const target = fetchTarget(point);
      return {
        value: point.value,
        target: target,
      };
    });
    style.parameters.fill = {
      type: "rangeMap",
      gradient: style.parameters.continuous,
      expressionObject: {
        properties: [style.parameters.property],
        values: [],
        expression: "property1",
      },
      defaultTarget: defaultTarget,
      rangeMap: rangeMap,
    };

    delete style.parameters.continuous;
    delete style.parameters.property;
    delete style.parameters.transitionPoints;
  } else if (style.method === "classToColor") {
    const valueMap = style.parameters.colorMapping.map((point) => {
      const target = fetchTarget(point);
      return {
        value: point.value,
        target: target,
      };
    });
    style.parameters.fill = {
      type: "valueMap",
      expressionObject: {
        properties: [style.parameters.property],
        values: [],
        expression: "property1",
      },
      defaultTarget: defaultTarget,
      valueMap: valueMap,
    };

    delete style.parameters.property;
    delete style.parameters.colorMapping;
  } else if (style.method === "formula") {
    const rangeMap = style.parameters.transitionPoints.map((point) => {
      const target = fetchTarget(point);
      return {
        value: point.value,
        target: target,
      };
    });

    style.parameters.fill = {
      type: "rangeMap",
      gradient: style.parameters.continuous,
      expressionObject: {
        properties: style.parameters.properties,
        values: [],
        expression: style.parameters.formula,
      },
      defaultTarget: defaultTarget,
      rangeMap: rangeMap,
    };
    delete style.parameters.properties;
    delete style.parameters.formula;
    delete style.parameters.continuous;
    delete style.parameters.transitionPoints;
  }

  style.method = "v2";
  return style;
}

function getVectorLayerColor(properties, style, ktype = "fill") {
  style = convertVectorStyle(style);

  const c = getVectorLayerColorNew(properties, style, ktype);
  return c;
}

export {
  EllipsisVectorLayerBase,
  getFeatureStyling,
  getVectorLayerColor,
  parseHex,
};
