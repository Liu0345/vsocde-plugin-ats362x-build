import ats362xData from './data/ats362x.json';

export interface ChipFunction {
  name: string;
  mfp: string;
  category: string;
  instance: string;
}

export interface ChipPin {
  packagePin: string;
  name: string;
  description: string;
  functions: ChipFunction[];
}

export interface ChipDefinition {
  id: string;
  label: string;
  model: string;
  package: string;
  modules: ChipModule[];
  defaultModule: string;
  source: string[];
  defaults: { category: string; instance: string };
  pins: ChipPin[];
}

export interface ChipModule {
  id: string;
  label: string;
  pins: ModulePin[];
}

export interface ModulePin {
  number: number;
  label: string;
  chipPinName?: string;
}

interface RawChipModule {
  id: string;
  label: string;
  pins: Array<[number, string, string]>;
}

interface RawChipDefinition {
  id: string;
  label: string;
  model: string;
  package: string;
  modules: RawChipModule[];
  defaultModule: string;
  source: string[];
  defaults: { category: string; instance: string };
  pins: Array<[string, string, string, Array<[string, string, string]>]>;
}

function functionInstance(name: string, category: string): string {
  const normalized = name.toUpperCase();
  const patterns: Record<string, RegExp> = {
    GPIO: /^(?:GPIO|WIO)\d+/,
    I2S: /^I2SG?\d+/,
    I2C: /^I2C\d+/,
    SPI: /^SPI\d+/,
    UART: /^UART\d+/,
    DMIC: /^DMIC\d+/,
    PWM: /^PWM\d+/,
    TIMER: /^TIMER\d+/,
    LRADC: /^LRADC\d+/,
    SD: /^SD\d+/,
    SPDIF: /^SPDIF(?:TX|RX)?/
  };
  return normalized.match(patterns[category] ?? /$a/)?.[0] ?? '';
}

function functionCategory(name: string, sourceCategory: string): string {
  const normalized = name.toUpperCase();
  const categories: Array<[RegExp, string]> = [
    [/^(?:GPIO|WIO)\d+$/, 'GPIO'],
    [/^I2S/, 'I2S'],
    [/^I2C/, 'I2C'],
    [/^SPI/, 'SPI'],
    [/^UART/, 'UART'],
    [/^DMIC/, 'DMIC'],
    [/^PWM/, 'PWM'],
    [/^TIMER/, 'TIMER'],
    [/^LRADC/, 'LRADC'],
    [/^SD\d/, 'SD'],
    [/^SPDIF/, 'SPDIF'],
    [/^LCD/, 'LCD'],
    [/^CEC/, 'CEC'],
    [/^IRC/, 'IRC'],
    [/^(?:HOSC|LOSC|RC\d+K|VRBGR)/, 'CLOCK'],
    [/^(?:SWCLK|SWIO)/, 'JTAG']
  ];
  return categories.find(([pattern]) => pattern.test(normalized))?.[1] ?? sourceCategory;
}

function defineChip(raw: RawChipDefinition): ChipDefinition {
  return {
    ...raw,
    modules: raw.modules.map((module) => ({
      ...module,
      pins: module.pins.map(([number, label, chipPinName]) => ({
        number,
        label,
        chipPinName: chipPinName || undefined
      }))
    })),
    pins: raw.pins.map(([packagePin, name, description, functions]) => ({
      packagePin,
      name,
      description,
      functions: functions.map(([functionName, mfp, sourceCategory]) => {
        const category = functionCategory(functionName, sourceCategory);
        return {
          name: functionName,
          mfp,
          category,
          instance: functionInstance(functionName, category)
        };
      })
    }))
  };
}

// 新芯片只需按 RawChipDefinition 结构增加数据文件，并在此注册。
export const chipRegistry: ChipDefinition[] = [
  defineChip(ats362xData as unknown as RawChipDefinition)
];

export function chipCategories(chip: ChipDefinition): string[] {
  const preferred = ['GPIO', 'I2C', 'SPI', 'UART', 'I2S', 'DMIC', 'PWM', 'SD', 'SPDIF', 'TIMER', 'LRADC', 'LCD', 'JTAG', 'CLOCK', 'CEC', 'IRC', '其他'];
  const categories = new Set(chip.pins.flatMap((pin) => pin.functions.map((item) => item.category)));
  return [...categories].sort((left, right) => {
    const leftIndex = preferred.indexOf(left);
    const rightIndex = preferred.indexOf(right);
    if (leftIndex === -1 && rightIndex === -1) return left.localeCompare(right, 'en');
    if (leftIndex === -1) return 1;
    if (rightIndex === -1) return -1;
    return leftIndex - rightIndex;
  });
}

export function chipInstances(chip: ChipDefinition, category: string): string[] {
  return [...new Set(chip.pins.flatMap((pin) => pin.functions)
    .filter((item) => !category || item.category === category)
    .map((item) => item.instance)
    .filter(Boolean))]
    .sort((left, right) => left.localeCompare(right, 'en', { numeric: true }));
}
