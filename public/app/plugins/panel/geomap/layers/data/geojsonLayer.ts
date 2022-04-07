import {
  MapLayerRegistryItem,
  MapLayerOptions,
  PanelData,
  GrafanaTheme2,
  PluginState,
  SelectableValue,
} from '@grafana/data';
import OlMap from 'ol/Map';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import GeoJSON from 'ol/format/GeoJSON';
import { unByKey } from 'ol/Observable';
import { checkFeatureMatchesStyleRule } from '../../utils/checkFeatureMatchesStyleRule';
import { ComparisonOperation, FeatureRuleConfig, FeatureStyleConfig } from '../../types';
import { Fill, Stroke, Style } from 'ol/style';
import { FeatureLike } from 'ol/Feature';
import { GeomapStyleRulesEditor } from '../../editor/GeomapStyleRulesEditor';
import { defaultStyleConfig, StyleConfig, StyleConfigState, StyleDimensions } from '../../style/types';
import { getStyleConfigState } from '../../style/utils';
import { polyStyle } from '../../style/markers';
import { StyleEditor } from './StyleEditor';
import { ReplaySubject } from 'rxjs';
import { map as rxjsmap, first } from 'rxjs/operators';
import { getLayerPropertyInfo } from '../../utils/getFeatures';
import { GrafanaDatasource } from 'app/plugins/datasource/grafana/datasource';
import { getDataSourceSrv } from '@grafana/runtime';
import { findField, getColorDimension } from '../../../../../features/dimensions';

enum ConfigMode {
  Json = 'json',
  Data = 'data',
}
export interface GeoJSONMapperConfig {
  // URL for a geojson file
  src?: string;

  // The default style (applied if no rules match)
  style: StyleConfig;

  mode: ConfigMode;

  // Pick style based on a rule
  rules: FeatureStyleConfig[];
  idField?: string;
  dataStyle: StyleConfig;
}

const defaultOptions: GeoJSONMapperConfig = {
  src: 'public/maps/countries.geojson',
  rules: [],
  style: defaultStyleConfig,
  mode: ConfigMode.Json,
  dataStyle: {},
};

interface StyleCheckerState {
  state: StyleConfigState;
  poly?: Style | Style[];
  point?: Style | Style[];
  rule?: FeatureRuleConfig;
}

export const DEFAULT_STYLE_RULE: FeatureStyleConfig = {
  style: defaultStyleConfig,
  check: {
    property: '',
    operation: ComparisonOperation.EQ,
    value: '',
  },
};

let publicGeoJSONFiles: Array<SelectableValue<string>> | undefined = undefined;

export const geojsonLayer: MapLayerRegistryItem<GeoJSONMapperConfig> = {
  id: 'geojson',
  name: 'GeoJSON',
  description: 'Load static data from a geojson file',
  isBaseMap: false,
  state: PluginState.beta,

  /**
   * Function that configures transformation and returns a transformer
   * @param map
   * @param options
   * @param theme
   */
  create: async (map: OlMap, options: MapLayerOptions<GeoJSONMapperConfig>, theme: GrafanaTheme2) => {
    const config = { ...defaultOptions, ...options.config };

    const source = new VectorSource({
      url: config.src,
      format: new GeoJSON(),
    });

    const features = new ReplaySubject<FeatureLike[]>();

    const key = source.on('change', () => {
      //one geojson loads
      if (source.getState() == 'ready') {
        unByKey(key);
        features.next(source.getFeatures());
      }
    });

    const styles: StyleCheckerState[] = [];
    if (config.rules) {
      for (const r of config.rules) {
        if (r.style) {
          const s = await getStyleConfigState(r.style);
          styles.push({
            state: s,
            rule: r.check,
          });
        }
      }
    }
    if (true) {
      const s = await getStyleConfigState(config.style);
      styles.push({
        state: s,
      });
    }

    const style = await getStyleConfigState(config.style);
    const idToIdx = new Map<string, number>();

    const vectorLayer = new VectorLayer({
      source,
      style: (feature: FeatureLike) => {
        const idx = idToIdx.get(feature.getId() as string);
        const dims = style.dims;

        if (idx != null && dims !== undefined) {
          return new Style({
            fill: new Fill({ color: dims.color?.get(idx) }),
            stroke: new Stroke({ color: style.base.color, width: style.base.lineWidth ?? 1 }),
          });
        }

        const isPoint = feature.getGeometry()?.getType() === 'Point';

        for (const check of styles) {
          if (check.rule && !checkFeatureMatchesStyleRule(check.rule, feature)) {
            continue;
          }

          // Support dynamic values
          if (check.state.fields) {
            const values = { ...check.state.base };
            const { text } = check.state.fields;

            if (text) {
              values.text = `${feature.get(text)}`;
            }
            if (isPoint) {
              return check.state.maker(values);
            }
            return polyStyle(values);
          }

          // Lazy create the style object
          if (isPoint) {
            if (!check.point) {
              check.point = check.state.maker(check.state.base);
            }
            return check.point;
          }

          if (!check.poly) {
            check.poly = polyStyle(check.state.base);
          }
          return check.poly;
        }
        return undefined; // unreachable
      },
    });

    return {
      init: () => vectorLayer,
      update: (data: PanelData) => {
        if (config.mode === 'json') {
          return;
        }

        const frame = data.series[0];
        const dims: StyleDimensions = {};

        if (frame) {
          dims.color = getColorDimension(frame, config.dataStyle.color ?? defaultStyleConfig.color, theme);
          const field = findField(frame, config.idField);

          if (field) {
            field.values.toArray().forEach((v, i) => idToIdx.set(v, i));
          }

          style.dims = dims;
        }

        vectorLayer.changed();
      },
      registerOptionsUI: (builder) => {
        // get properties for first feature to use as ui options
        const layerInfo = features.pipe(
          first(),
          rxjsmap((v) => getLayerPropertyInfo(v))
        );

        if (!publicGeoJSONFiles) {
          initGeojsonFiles();
        }

        builder
          .addSelect({
            path: 'config.src',
            name: 'GeoJSON URL',
            settings: {
              options: publicGeoJSONFiles ?? [],
              allowCustomValue: true,
            },
            defaultValue: defaultOptions.src,
          })
          .addCustomEditor({
            id: 'config.style',
            path: 'config.style',
            name: 'Default style',
            description: 'The style to apply when no rules above match',
            editor: StyleEditor,
            settings: {
              simpleFixedValues: true,
              layerInfo,
            },
            defaultValue: defaultOptions.style,
          })
          .addRadio({
            path: 'config.mode',
            name: 'Mode',
            description: '',
            settings: {
              options: [
                { label: 'Data', value: ConfigMode.Data },
                { label: 'GeoJSON', value: ConfigMode.Json },
              ],
            },
            defaultValue: defaultOptions.mode,
          })
          .addFieldNamePicker({
            path: 'config.idField',
            name: 'ID Field',
            showIf: (cfg) => !(cfg.config.mode === 'json')
          })
          .addCustomEditor({
            id: 'config.dataStyle',
            path: 'config.dataStyle',
            name: 'Data style',
            editor: StyleEditor,
            settings: {
              displayRotation: false,
            },
            defaultValue: defaultOptions.dataStyle,
            showIf: (cfg) => !(cfg.config.mode === 'json')
          })
          .addCustomEditor({
            id: 'config.rules',
            path: 'config.rules',
            name: 'Style rules',
            description: 'Apply styles based on feature properties',
            editor: GeomapStyleRulesEditor,
            settings: {
              features,
              layerInfo,
            },
            defaultValue: [],
            showIf: (cfg) => cfg.config.mode === 'json'
          });
      },
    };
  },
  defaultOptions,
};

// This will find all geojson files in the maps and gazetteer folders
async function initGeojsonFiles() {
  if (publicGeoJSONFiles) {
    return;
  }
  publicGeoJSONFiles = [];

  const ds = (await getDataSourceSrv().get('-- Grafana --')) as GrafanaDatasource;
  for (let folder of ['maps', 'gazetteer']) {
    ds.listFiles(folder).subscribe({
      next: (frame) => {
        frame.forEach((item) => {
          if (item.name.endsWith('.geojson')) {
            const value = `public/${folder}/${item.name}`;
            publicGeoJSONFiles!.push({
              value,
              label: value,
            });
          }
        });
      },
    });
  }
}
