// The web build reuses pure helpers from src/model.ts; these stand in for Obsidian imports it never calls.
export class App {}
export class TFile {}
export class TFolder {}
export const normalizePath = (p: string) => p;
export const getAllTags = () => null;
