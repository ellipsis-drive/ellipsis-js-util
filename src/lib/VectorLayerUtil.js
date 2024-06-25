import EllipsisVectorLayerBase from "./EllipsisVectorLayerBase";
import { mergeObjects } from "./Util";
import { evaluate } from "mathjs";

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
const getFeatureStyling = (feature, style) => {
  console.log("style", style);
  const stylingProperties = {
    radius:
      style.parameters.radius.parameters.value ??
      style.parameters.radius.parameters.weight,
    weight: style.parameters.width,
    opacity: 1,
    fillColor: parseHex(feature.properties.color).color,
    fillOpacity: style.parameters.alpha,
    color: parseHex(style.parameters.borderColor ?? feature.properties.color)
      .color,
    popupProperty: style.parameters.popupProperty,
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
};

function getVectorLayerColor(properties, style) {
  let color;

  switch (style.method) {
    case STYLE_METHOD.formula: {
      let propertyNames = style.parameters.properties;

      let propertyValues = [];
      for (let i = 0; i < propertyNames.length; i++) {
        propertyValues.push(properties[propertyNames[i]]);
      }

      if (
        propertyValues.filter((x) => x === null || x === undefined).length > 0
      ) {
        color = style.parameters.defaultColor;
        break;
      }

      let evaluationProperties = {};
      for (let i = 0; i < propertyValues.length; i++) {
        evaluationProperties[`property${i + 1}`] = propertyValues[i];
      }

      let propertyValue = evaluate(
        style.parameters.formula,
        evaluationProperties
      );

      let transitionPoints = style.parameters.transitionPoints;

      if (style.parameters.periodic) {
        propertyValue = propertyValue % style.parameters.periodic;
      }

      let values = style.parameters.transitionPoints.map((x) => x.value);

      if (propertyValue <= values[0]) {
        color = transitionPoints[0].color;
      } else if (propertyValue >= values[values.length - 1]) {
        color = transitionPoints[values.length - 1].color;
      } else {
        let lowerPoint;
        let higherPoint;

        for (let i = 1; i < values.length; i++) {
          if (propertyValue < values[i]) {
            lowerPoint = transitionPoints[i - 1];
            higherPoint = transitionPoints[i];
            break;
          }
        }

        if (style.parameters.continuous) {
          let fraction =
            (propertyValue - lowerPoint.value) /
            (higherPoint.value - lowerPoint.value);
          let red = rgbComponentToHex(
            fraction * parseInt(higherPoint.color.substring(1, 3), 16) +
              (1 - fraction) * parseInt(lowerPoint.color.substring(1, 3), 16)
          );
          let blue = rgbComponentToHex(
            fraction * parseInt(higherPoint.color.substring(3, 5), 16) +
              (1 - fraction) * parseInt(lowerPoint.color.substring(3, 5), 16)
          );
          let green = rgbComponentToHex(
            fraction * parseInt(higherPoint.color.substring(5, 7), 16) +
              (1 - fraction) * parseInt(lowerPoint.color.substring(5, 7), 16)
          );
          color = "#" + red + blue + green;
        } else {
          color = lowerPoint.color;
        }
      }
      color = color + alphaToHex(style.parameters.alpha);

      break;
    }
    case STYLE_METHOD.rules: {
      color = style.parameters.defaultColor;
      for (let i = 0; i < style.parameters.rules.length; i++) {
        let rule = style.parameters.rules[i];

        let propertyValue = property ? properties[rule.property] : undefined;
        let match = false;

        if (propertyValue === undefined || propertyValue === null) {
          break;
        }

        // eslint-disable-next-line default-case
        switch (rule.operator) {
          case "=":
            match = propertyValue === rule.value;
            break;
          case "!=":
            match = propertyValue !== rule.value;
            break;
          case ">":
            match = propertyValue > rule.value;
            break;
          case "<":
            match = propertyValue < rule.value;
            break;
          case ">=":
            match = propertyValue >= rule.value;
            break;
          case "<=":
            match = propertyValue <= rule.value;
            break;
        }

        if (match) {
          color = rule.color;
          break;
        }
      }

      color = color + alphaToHex(style.parameters.alpha);
      break;
    }
    case STYLE_METHOD.classToColor: {
      color = style.parameters.defaultColor;

      let propertyValue = properties[style.parameters.property];
      let c;
      if (propertyValue) {
        c = style.parameters.colorMapping.find(
          (x) => x.value === propertyValue
        )?.color;
      }

      if (c) {
        color = c;
      }

      color = color + alphaToHex(style.parameters.alpha);
      break;
    }
    case STYLE_METHOD.transitionPoints: {
      let propertyValue = properties[style.parameters.property];

      let transitionPoints = style.parameters.transitionPoints;

      if (
        style.parameters.periodic &&
        propertyValue !== undefined &&
        propertyValue !== null
      ) {
        propertyValue = propertyValue % style.parameters.periodic;
      }

      let values = style.parameters.transitionPoints.map((x) => x.value);

      if (propertyValue === undefined || propertyValue === null) {
        color = style.parameters.defaultColor;
      } else if (propertyValue <= values[0]) {
        color = transitionPoints[0].color;
      } else if (propertyValue >= values[values.length - 1]) {
        color = transitionPoints[values.length - 1].color;
      } else {
        let lowerPoint;
        let higherPoint;

        for (let i = 1; i < values.length; i++) {
          if (propertyValue < values[i]) {
            lowerPoint = transitionPoints[i - 1];
            higherPoint = transitionPoints[i];
            break;
          }
        }

        if (style.parameters.continuous) {
          let fraction =
            (propertyValue - lowerPoint.value) /
            (higherPoint.value - lowerPoint.value);
          let red = rgbComponentToHex(
            fraction * parseInt(higherPoint.color.substring(1, 3), 16) +
              (1 - fraction) * parseInt(lowerPoint.color.substring(1, 3), 16)
          );
          let blue = rgbComponentToHex(
            fraction * parseInt(higherPoint.color.substring(3, 5), 16) +
              (1 - fraction) * parseInt(lowerPoint.color.substring(3, 5), 16)
          );
          let green = rgbComponentToHex(
            fraction * parseInt(higherPoint.color.substring(5, 7), 16) +
              (1 - fraction) * parseInt(lowerPoint.color.substring(5, 7), 16)
          );
          color = "#" + red + blue + green;
        } else {
          color = lowerPoint.color;
        }
      }

      color = color + alphaToHex(style.parameters.alpha);
      break;
    }
    case STYLE_METHOD.random: {
      let propertyValue;
      if (style.parameters.property) {
        propertyValue = properties[style.parameters.property];
      } else {
        propertyValue = properties.id;
      }

      if (propertyValue === undefined || propertyValue === null) {
        propertyValue = "ellipsis_missing_value"; // use this string if value is missing, can be changed to any string with unlikely collision
      }

      let originalHex = crypto
        .createHash("sha256")
        .update(propertyValue.toString())
        .digest("hex")
        .substr(-6);
      color =
        "#" +
        rgbHexConversion(originalHex) +
        alphaToHex(style.parameters.alpha);
      break;
    }
    case STYLE_METHOD.singleColor: {
      color = style.parameters.color + alphaToHex(style.parameters.alpha);
      break;
    }
    case STYLE_METHOD.fromColorProperty: {
      color = style.parameters.defaultColor;

      if (properties.color) {
        color = properties.color.substring(0, 7);
      }

      color = color + alphaToHex(style.parameters.alpha);
      break;
    }
    default: {
      throw Error(`Received invalid method in getLayerColor: ${style.method}`);
    }
  }

  return color;
}

export {
  EllipsisVectorLayerBase,
  getFeatureStyling,
  getVectorLayerColor,
  parseHex,
};
