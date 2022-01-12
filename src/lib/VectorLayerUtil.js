import EllipsisVectorLayerBase from "./EllipsisVectorLayerBase";
import { mergeObjects } from "./Util";

const defaultStyle = {
    radius: 6,
    width: 2,
    borderColor: '#000000',
    borderOpacity: 1,
    fillColor: '#000000',
    fillOpacity: 0.5
}

//Map style keys to possible aliases
const styleKeys = {
    radius: ['radius'],
    width: ['width', 'lineWidth'],
    borderColor: ['borderColor', 'color'],
    borderOpacity: ['borderOpacity', 'opacity'],
    fillColor: ['fillColor'],
    fillOpacity: ['fillOpacity']
}

const parseHex = (color, toRGB) => {
    if (!color) return;

    const splitHexComponents = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})?$/i.exec(color);

    //Retreive all color components from hex
    let [r, g, b, opacity] = splitHexComponents.slice(1).map(x => parseInt(x, 16));
    opacity = isNaN(opacity) ? opacity = undefined : opacity /= 255;


    if (toRGB) return { r, g, b, opacity };
    return { color: `#${splitHexComponents.slice(1, 4).join('')}`, opacity };
}

//Finds styling info based on styleKeysInfo. It'll return all style info with the style
//keys described in styleKeysInfo.
const extractStyling = (obj, styleKeysInfo = styleKeys) => {
    const styling = {};
    Object.entries(obj).forEach(([key, value]) => {
        const standardStylingEntry = Object.entries(styleKeysInfo).find(([styleKey, styleAliases]) => {
            return styleKey === key || (styleAliases && styleAliases.includes(key));
        });
        if (standardStylingEntry)
            styling[standardStylingEntry[0]] = value;
    });
    return styling;
}


/**
 * Parses hex color values from feature to create an object that has all styling
 * parameters merged, which does include default stylings.
 * Priority of the different places to pass styling:
 * 1) stylingOptions
 * 2) feature.properties.style
 * 3) feature.properties
 * 4) default styling
 * if fillcolor and fillopacity are not set, the opacity of colors is used.
 * @param {*} feature 
 * @param {*} stylingOptions 
 * @returns {*}
 */
const getFeatureStyling = (feature, stylingOptions) => {

    //Extract style info from feature.properties, feature.properties.style and stylingOptions.
    const propertyStyle = feature && feature.properties ? extractStyling(feature.properties) : undefined;
    const propertyStyleStyle = feature && feature.properties && feature.properties.style ? extractStyling(feature.properties.style) : undefined;
    const options = stylingOptions ? extractStyling(stylingOptions) : undefined;

    //Rightmost value will take precidence over values to the left in merge.
    let combinedStyles = mergeObjects(propertyStyle, propertyStyleStyle, options);


    //Split hex values in opacity and hex value if possible.
    let parsedBorderColor = parseHex(combinedStyles.borderColor);
    let parsedFillColor = parseHex(combinedStyles.fillColor);

    //If no fill color present, take color from border.
    if (parsedBorderColor && !parsedFillColor) {
        parsedFillColor = { ...parsedBorderColor };
        parsedBorderColor.opacity = 1;
    }

    //If no border color present, take color from fill.
    if (!parsedBorderColor && parsedFillColor) {
        parsedBorderColor = { ...parsedFillColor };
        parsedBorderColor.opacity = 1;
    }

    //If we parsed colors, combine the results 
    if (parsedBorderColor) {
        //Merge priority: 
        //1) parsed colors, 
        //2) opacities found in style, 
        //3) parsed opacities
        combinedStyles = mergeObjects({
            fillOpacity: parsedFillColor.fillOpacity,
            borderOpacity: parsedBorderColor.opacity
        }, combinedStyles, {
            fillColor: parsedFillColor.color,
            borderColor: parsedBorderColor.color,
        });
    }

    //Ensure the default values for all values that are not set in combined styles.
    return mergeObjects(defaultStyle, combinedStyles);
}

export {
    EllipsisVectorLayerBase,
    defaultStyle, styleKeys,
    getFeatureStyling, parseHex, extractStyling
};