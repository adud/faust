/************************************************************************
 ************************************************************************
    FAUST compiler
    Copyright (C) 2003-2020 GRAME, Centre National de Creation Musicale
    ---------------------------------------------------------------------
    This program is free software; you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation; either version 2 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program; if not, write to the Free Software
    Foundation, Inc., 675 Mass Ave, Cambridge, MA 02139, USA.
 ************************************************************************
 ************************************************************************/

///<reference path="FaustWebAudio.d.ts"/>

namespace Faust {

    interface UIHandler { (item: TFaustUIItem): void }

    export class BaseDSPImp implements BaseDSP {

        protected fOutputHandler: OutputParamHandler | null;
        protected fComputeHandler: ComputeHandler | null;
        protected fPlotHandler: PlotHandler | null;

        protected fCachedEvents: { type: string; data: any }[];
        protected fBufferNum: number;

        protected fInChannels: Float32Array[];
        protected fOutChannels: Float32Array[];

        protected fOutputsTimer: number;
        protected fInputsItems: string[];
        protected fOutputsItems: string[];

        // Buffers in wasm memory
        protected fAudioInputs!: AudioBuffer;
        protected fAudioOutputs!: AudioBuffer;

        protected fBufferSize: number;
        protected gPtrSize: number;
        protected gSampleSize: number;

        protected fPitchwheelLabel: { path: string; min: number; max: number }[];
        protected fCtrlLabel: { path: string; min: number; max: number }[][];
        protected fPathTable: { [address: string]: number };
        protected fUICallback: UIHandler;

        protected fDestroyed: boolean;

        protected fJSONDsp!: TFaustJSON;

        constructor(buffer_size: number) {
            this.fOutputHandler = null;
            this.fComputeHandler = null;

            // To handle MIDI events plot
            this.fCachedEvents = [];
            this.fBufferNum = 0;
            this.fPlotHandler = null;

            this.fBufferSize = buffer_size;

            this.fInChannels = [];
            this.fOutChannels = [];

            this.gPtrSize = 4;
            this.gSampleSize = 4;

            this.fOutputsTimer = 5;
            this.fInputsItems = [];
            this.fOutputsItems = [];

            this.fPitchwheelLabel = [];
            this.fCtrlLabel = new Array(128).fill(null).map(() => []);
            this.fPathTable = {};

            this.fDestroyed = false;

            this.fUICallback = (item: TFaustUIItem) => {
                if (item.type === "hbargraph" || item.type === "vbargraph") {
                    // Keep bargraph adresses
                    this.fOutputsItems.push(item.address);
                    this.fPathTable[item.address] = item.index;
                } else if (item.type === "vslider" || item.type === "hslider" || item.type === "button" || item.type === "checkbox" || item.type === "nentry") {
                    // Keep inputs adresses
                    this.fInputsItems.push(item.address);
                    this.fPathTable[item.address] = item.index;
                    // Parse 'midi' metadata
                    if (!item.meta) return
                    item.meta.forEach((meta) => {
                        const { midi } = meta;
                        if (!midi) return;
                        const strMidi = midi.trim();
                        if (strMidi === "pitchwheel") {
                            this.fPitchwheelLabel.push({ path: item.address, min: item.min, max: item.max });
                        } else {
                            const matched = strMidi.match(/^ctrl\s(\d+)/);
                            if (!matched) return;
                            this.fCtrlLabel[parseInt(matched[1])].push({ path: item.address, min: item.min, max: item.max });
                        }
                    });
                }
            }
        }

        // Tools
        static remap(v: number, mn0: number, mx0: number, mn1: number, mx1: number) {
            return (v - mn0) / (mx0 - mn0) * (mx1 - mn1) + mn1;
        }

        // JSON parsing functions
        static parseUI(ui: TFaustUI, callback: (...args: any[]) => any) {
            ui.forEach(group => BaseDSPImp.parseGroup(group, callback));
        }

        static parseGroup(group: TFaustUIGroup, callback: (...args: any[]) => any) {
            if (group.items) {
                BaseDSPImp.parseItems(group.items, callback);
            }
        }
        static parseItems(items: TFaustUIItem[], callback: (...args: any[]) => any) {
            items.forEach(item => BaseDSPImp.parseItem(item, callback));
        }

        static parseItem(item: TFaustUIItem, callback: (...args: any[]) => any) {
            if (item.type === "vgroup" || item.type === "hgroup" || item.type === "tgroup") {
                BaseDSPImp.parseItems(item.items, callback);
            } else {
                callback(item);
            }
        }

        protected updateOutputs() {
            if (this.fOutputsItems.length > 0 && this.fOutputHandler && this.fOutputsTimer-- === 0) {
                this.fOutputsTimer = 5;
                this.fOutputsItems.forEach(item => { if (this.fOutputHandler) this.fOutputHandler(item, this.getParamValue(item)) });
            }
        }

        // Public API
        metadata(handler: MetadataHandler) { }

        compute(input: Float32Array[], output: Float32Array[]) {
            return false;
        }

        setOutputParamHandler(handler: OutputParamHandler | null) {
            this.fOutputHandler = handler;
        }
        getOutputParamHandler(): OutputParamHandler | null {
            return this.fOutputHandler;
        }

        setComputeHandler(handler: ComputeHandler | null) {
            this.fComputeHandler = handler;
        }
        getComputeHandler(): ComputeHandler | null {
            return this.fComputeHandler;
        }

        setPlotHandler(handler: PlotHandler | null) {
            this.fPlotHandler = handler;
        }
        getPlotHandler(): PlotHandler | null {
            return this.fPlotHandler;
        }

        getNumInputs() {
            return -1;
        }
        getNumOutputs() {
            return -1;
        }

        midiMessage(data: number[] | Uint8Array) {
            if (this.fPlotHandler) this.fCachedEvents.push({ data, type: "midi" });
            const cmd = data[0] >> 4;
            const channel = data[0] & 0xf;
            const data1 = data[1];
            const data2 = data[2];
            if (cmd === 11) return this.ctrlChange(channel, data1, data2);
            if (cmd === 14) return this.pitchWheel(channel, (data2 * 128.0 + data1));
        };

        ctrlChange(channel: number, ctrl: number, value: number) {
            if (this.fPlotHandler) this.fCachedEvents.push({ type: "ctrlChange", data: [channel, ctrl, value] });
            if (this.fCtrlLabel[ctrl].length) {
                this.fCtrlLabel[ctrl].forEach((ctrl) => {
                    const { path } = ctrl;
                    this.setParamValue(path, BaseDSPImp.remap(value, 0, 127, ctrl.min, ctrl.max));
                    // Typically used to reflect parameter change on GUI
                    if (this.fOutputHandler) this.fOutputHandler(path, this.getParamValue(path));
                });
            }
        }

        pitchWheel(channel: number, wheel: number) {
            if (this.fPlotHandler) this.fCachedEvents.push({ type: "pitchWheel", data: [channel, wheel] });
            this.fPitchwheelLabel.forEach((pw) => {
                this.setParamValue(pw.path, BaseDSPImp.remap(wheel, 0, 16383, pw.min, pw.max));
                // Typically used to reflect parameter change on GUI
                if (this.fOutputHandler) this.fOutputHandler(pw.path, this.getParamValue(pw.path));
            });
        }

        setParamValue(path: string, value: number) { }
        getParamValue(path: string) { return 0; }

        getParams() { return this.fInputsItems; }
        getJSON() { return ""; }
        getUI() { return this.fJSONDsp.ui; }
        destroy() {
            this.fDestroyed = true;
            this.fOutputHandler = null;
            this.fComputeHandler = null;
            this.fPlotHandler = null;
        }
    }

    // Monophonic DSP

    // Public contructor
    export function createMonoDSP(instance: MonoInstance, sample_rate: number, buffer_size: number) {
        return new MonoDSPImp(instance, sample_rate, buffer_size);
    }

    export class MonoDSPImp extends BaseDSPImp implements MonoDSP {

        private fInstance: MonoInstance;
        private fDSP!: DSP;

        constructor(instance: MonoInstance, sample_rate: number, buffer_size: number) {

            super(buffer_size);
            this.fInstance = instance;

            // Create JSON object
            this.fJSONDsp = JSON.parse(this.fInstance.json);

            // Setup GUI
            BaseDSPImp.parseUI(this.fJSONDsp.ui, this.fUICallback);

            // Setup wasm memory
            this.initMemory();

            // Init DSP
            this.fInstance.api.init(this.fDSP, sample_rate);
        }

        private initMemory() {

            // Start of DSP memory: Mono DSP is placed first with index 0
            this.fDSP = 0;

            // Audio buffer start at the end of DSP
            let audio_ptr = this.fJSONDsp.size;

            // Setup audio pointers offset
            this.fAudioInputs = audio_ptr;
            this.fAudioOutputs = this.fAudioInputs + this.getNumInputs() * this.gPtrSize;

            // Prepare wasm memory layout
            let audio_inputs_ptr = this.fAudioOutputs + this.getNumOutputs() * this.gPtrSize;
            let audio_outputs_ptr = audio_inputs_ptr + this.getNumInputs() * this.fBufferSize * this.gSampleSize;

            const HEAP = this.fInstance.memory.buffer;
            const HEAP32 = new Int32Array(HEAP);
            const HEAPF32 = new Float32Array(HEAP);

            if (this.getNumInputs() > 0) {
                for (let chan = 0; chan < this.getNumInputs(); chan++) {
                    HEAP32[(this.fAudioInputs >> 2) + chan] = audio_inputs_ptr + this.fBufferSize * this.gSampleSize * chan;
                }
                // Prepare Ins buffer tables
                const dspInChans = HEAP32.subarray(this.fAudioInputs >> 2, (this.fAudioInputs + this.getNumInputs() * this.gPtrSize) >> 2);
                for (let chan = 0; chan < this.getNumInputs(); chan++) {
                    this.fInChannels[chan] = HEAPF32.subarray(dspInChans[chan] >> 2, (dspInChans[chan] + this.fBufferSize * this.gSampleSize) >> 2);
                }
            }
            if (this.getNumOutputs() > 0) {
                for (let chan = 0; chan < this.getNumOutputs(); chan++) {
                    HEAP32[(this.fAudioOutputs >> 2) + chan] = audio_outputs_ptr + this.fBufferSize * this.gSampleSize * chan;
                }
                // Prepare Out buffer tables
                const dspOutChans = HEAP32.subarray(this.fAudioOutputs >> 2, (this.fAudioOutputs + this.getNumOutputs() * this.gPtrSize) >> 2);
                for (let chan = 0; chan < this.getNumOutputs(); chan++) {
                    this.fOutChannels[chan] = HEAPF32.subarray(dspOutChans[chan] >> 2, (dspOutChans[chan] + this.fBufferSize * this.gSampleSize) >> 2);
                }
            }

            console.log("============== Mono Memory layout ==============");
            console.log("this.fBufferSize: " + this.fBufferSize);
            console.log("this.fJSONDsp.size: " + this.fJSONDsp.size);
            console.log("this.fAudioInputs: " + this.fAudioInputs);
            console.log("this.fAudioOutputs: " + this.fAudioOutputs);
            console.log("audio_inputs_ptrs: " + audio_inputs_ptr);
            console.log("audio_outputs_ptr: " + audio_outputs_ptr);
            console.log("this.fDSP: " + this.fDSP);
        }

        // Public API
        compute(input: Float32Array[], output: Float32Array[]) {

            // Check DSP state
            if (this.fDestroyed) return false;

            // Check inputs
            if (this.getNumInputs() > 0 && (!input || !input[0] || input[0].length === 0)) {
                // console.log("Process input error");
                return true;
            }

            // Check outputs
            if (this.getNumOutputs() > 0 && (!output || !output[0] || output[0].length === 0)) {
                // console.log("Process output error");
                return true;
            }

            // Copy inputs
            if (input !== undefined) {
                for (let chan = 0; chan < Math.min(this.getNumInputs(), input.length); ++chan) {
                    const dspInput = this.fInChannels[chan];
                    dspInput.set(input[chan]);
                }
            }

            // Possibly call an externally given callback (for instance to synchronize playing a MIDIFile...)
            if (this.fComputeHandler) this.fComputeHandler(this.fBufferSize);

            // Compute
            this.fInstance.api.compute(this.fDSP, this.fBufferSize, this.fAudioInputs, this.fAudioOutputs);

            // Update bargraph
            this.updateOutputs();

            if (output !== undefined) {
                // Copy outputs
                for (let chan = 0; chan < Math.min(this.getNumOutputs(), output.length); chan++) {
                    const dspOutput = this.fOutChannels[chan];
                    output[chan].set(dspOutput);
                }

                // PlotHandler handling 
                if (this.fPlotHandler) {
                    this.fPlotHandler(output, this.fBufferNum++, (this.fCachedEvents.length ? this.fCachedEvents : undefined));
                    this.fCachedEvents = [];
                }
            }

            return true;
        }

        metadata(handler: MetadataHandler) { }

        getNumInputs() {
            return this.fInstance.api.getNumInputs(this.fDSP);
        }
        getNumOutputs() {
            return this.fInstance.api.getNumOutputs(this.fDSP);
        }

        setParamValue(path: string, value: number) {
            if (this.fPlotHandler) this.fCachedEvents.push({ type: "param", data: { path, value } });
            this.fInstance.api.setParamValue(this.fDSP, this.fPathTable[path], value);
        }
        getParamValue(path: string) {
            return this.fInstance.api.getParamValue(this.fDSP, this.fPathTable[path]);
        }

        getJSON() { return this.fInstance.json; }
        getUI() { return this.fJSONDsp.ui; }
    }

    // Voice management
    interface TransformFunction { (val: number): number }

    export class DspVoice {

        static kActiveVoice: number;
        static kFreeVoice: number;
        static kReleaseVoice: number;
        static kNoVoice: number;
        private fFreqLabel: number[];
        private fGateLabel: number[];
        private fGainLabel: number[];
        private fDSP: DSP;         // Voice DSP location in wasm memory
        private fAPI: InstanceAPI; // Voice DSP code
        private fKeyFun: TransformFunction;
        private fVelFun: TransformFunction;
        // Accessed by PolyDSPImp class
        fNote: number;
        fDate: number;

        constructor(dsp: DSP,
            api: InstanceAPI,
            input_items: string[],
            path_table: { [address: string]: number },
            sample_rate: number) {
            // Voice state
            DspVoice.kActiveVoice = 0;
            DspVoice.kFreeVoice = -1;
            DspVoice.kReleaseVoice = -2;
            DspVoice.kNoVoice = -3;
            // Default versions
            this.fKeyFun = (pitch: number) => { return DspVoice.midiToFreq(pitch); }
            this.fVelFun = (velocity: number) => { return velocity / 127.0; }
            this.fNote = DspVoice.kFreeVoice;
            this.fDate = 0;
            this.fDSP = dsp;
            this.fAPI = api;
            this.fGateLabel = [];
            this.fGainLabel = [];
            this.fFreqLabel = [];
            this.fAPI.init(this.fDSP, sample_rate);
            this.extractPaths(input_items, path_table);
        }

        static midiToFreq(note: number) { return 440.0 * 2 ** ((note - 69) / 12) };

        private extractPaths(input_items: string[], path_table: { [address: string]: number }) {
            input_items.forEach((item) => {
                if (item.endsWith("/gate")) {
                    this.fGateLabel.push(path_table[item]);
                } else if (item.endsWith("/freq")) {
                    this.fKeyFun = (pitch: number) => { return DspVoice.midiToFreq(pitch); }
                    this.fFreqLabel.push(path_table[item]);
                } else if (item.endsWith("/key")) {
                    this.fKeyFun = (pitch: number) => { return pitch; }
                    this.fFreqLabel.push(path_table[item]);
                } else if (item.endsWith("/gain")) {
                    this.fVelFun = (velocity: number) => { return velocity / 127.0; }
                    this.fGainLabel.push(path_table[item]);
                } else if (item.endsWith("/vel") && item.endsWith("/velocity")) {
                    this.fVelFun = (velocity: number) => { return velocity; }
                    this.fGainLabel.push(path_table[item]);
                }
            });
        }

        // Public API
        keyOn(pitch: number, velocity: number) {
            this.fAPI.instanceClear(this.fDSP);
            this.fFreqLabel.forEach(index => this.fAPI.setParamValue(this.fDSP, index, this.fKeyFun(pitch)));
            this.fGateLabel.forEach(index => this.fAPI.setParamValue(this.fDSP, index, 1));
            this.fGainLabel.forEach(index => this.fAPI.setParamValue(this.fDSP, index, this.fVelFun(velocity)));
            // Keep pitch
            this.fNote = pitch;
        }

        keyOff(hard: boolean = false) {
            this.fGateLabel.forEach(index => this.fAPI.setParamValue(this.fDSP, index, 0));
            if (hard) {
                this.fNote = DspVoice.kFreeVoice;
            } else {
                this.fNote = DspVoice.kReleaseVoice;
            }
        }

        compute(buffer_size: number, inputs: AudioBuffer, outputs: AudioBuffer) {
            this.fAPI.compute(this.fDSP, buffer_size, inputs, outputs);
        }

        setParamValue(index: number, value: number) {
            this.fAPI.setParamValue(this.fDSP, index, value);
        }
        getParamValue(index: number) {
            return this.fAPI.getParamValue(this.fDSP, index);
        }
    }

    // Polyphonic DSP

    // Public contructor
    export function createPolyDSP(instance: PolyInstance, sample_rate: number, buffer_size: number) {
        return new PolyDSPImp(instance, sample_rate, buffer_size);
    }

    export class PolyDSPImp extends BaseDSPImp implements PolyDSP {

        private fInstance: PolyInstance;
        private fEffect!: DSP;
        private fJSONEffect: TFaustJSON;
        private fAudioMixing!: AudioBuffer;
        private fVoiceTable: DspVoice[];

        constructor(instance: PolyInstance, sample_rate: number, buffer_size: number) {
            super(buffer_size);
            this.fInstance = instance;

            // Create JSON for voice
            this.fJSONDsp = JSON.parse(this.fInstance.voice_json);

            // Create JSON for effect
            this.fJSONEffect = (this.fInstance.effect_api && this.fInstance.effect_json) ? JSON.parse(this.fInstance.effect_json) : null;

            // Setup GUI
            BaseDSPImp.parseUI(this.fJSONDsp.ui, this.fUICallback);
            if (this.fJSONEffect) BaseDSPImp.parseUI(this.fJSONEffect.ui, this.fUICallback);

            // Setup wasm memory
            this.initMemory();

            // Init DSP voices
            this.fVoiceTable = [];
            for (let voice = 0; voice < this.fInstance.voices; voice++) {
                this.fVoiceTable.push(new DspVoice(
                    this.fJSONDsp.size * voice,
                    this.fInstance.voice_api,
                    this.fInputsItems,
                    this.fPathTable,
                    sample_rate));
            }

            // Init effect
            if (this.fInstance.effect_api) this.fInstance.effect_api.init(this.fEffect, sample_rate);
        }

        private initMemory() {

            // Effet start at the end of all DSP voices
            this.fEffect = this.fJSONDsp.size * this.fInstance.voices;

            // Audio buffer start at the end of effect
            let audio_ptr = this.fEffect + ((this.fJSONEffect) ? this.fJSONEffect.size : 0);

            // Setup audio pointers offset
            this.fAudioInputs = audio_ptr;
            this.fAudioOutputs = this.fAudioInputs + this.getNumInputs() * this.gPtrSize;
            this.fAudioMixing = this.fAudioOutputs + this.getNumOutputs() * this.gPtrSize;

            // Prepare wasm memory layout
            let audio_inputs_ptr = this.fAudioMixing + this.getNumOutputs() * this.gPtrSize;
            let audio_outputs_ptr = audio_inputs_ptr + this.getNumInputs() * this.fBufferSize * this.gSampleSize;
            let audio_mixing_ptr = audio_outputs_ptr + this.getNumOutputs() * this.fBufferSize * this.gSampleSize;

            const HEAP = this.fInstance.memory.buffer;
            const HEAP32 = new Int32Array(HEAP);
            const HEAPF32 = new Float32Array(HEAP);

            if (this.getNumInputs() > 0) {
                for (let chan = 0; chan < this.getNumInputs(); chan++) {
                    HEAP32[(this.fAudioInputs >> 2) + chan] = audio_inputs_ptr + this.fBufferSize * this.gSampleSize * chan;
                }
                // Prepare Ins buffer tables
                const dspInChans = HEAP32.subarray(this.fAudioInputs >> 2, (this.fAudioInputs + this.getNumInputs() * this.gPtrSize) >> 2);
                for (let chan = 0; chan < this.getNumInputs(); chan++) {
                    this.fInChannels[chan] = HEAPF32.subarray(dspInChans[chan] >> 2, (dspInChans[chan] + this.fBufferSize * this.gSampleSize) >> 2);
                }
            }
            if (this.getNumOutputs() > 0) {
                for (let chan = 0; chan < this.getNumOutputs(); chan++) {
                    HEAP32[(this.fAudioOutputs >> 2) + chan] = audio_outputs_ptr + this.fBufferSize * this.gSampleSize * chan;
                    HEAP32[(this.fAudioMixing >> 2) + chan] = audio_mixing_ptr + this.fBufferSize * this.gSampleSize * chan;
                }
                // Prepare Out buffer tables
                const dspOutChans = HEAP32.subarray(this.fAudioOutputs >> 2, (this.fAudioOutputs + this.getNumOutputs() * this.gPtrSize) >> 2);
                for (let chan = 0; chan < this.getNumOutputs(); chan++) {
                    this.fOutChannels[chan] = HEAPF32.subarray(dspOutChans[chan] >> 2, (dspOutChans[chan] + this.fBufferSize * this.gSampleSize) >> 2);
                }
            }

            console.log("============== Poly Memory layout ==============");
            console.log("this.fBufferSize: " + this.fBufferSize);
            console.log("this.fJSONDsp.size: " + this.fJSONDsp.size);
            console.log("this.fAudioInputs: " + this.fAudioInputs);
            console.log("this.fAudioOutputs: " + this.fAudioOutputs);
            console.log("this.fAudioMixing: " + this.fAudioMixing);
            console.log("audio_inputs_ptrs: " + audio_inputs_ptr);
            console.log("audio_outputs_ptr: " + audio_outputs_ptr);
            console.log("audio_mixing_ptr: " + audio_mixing_ptr);
        }

        private allocVoice(voice: number) {
            this.fVoiceTable[voice].fDate++;
            this.fVoiceTable[voice].fNote = DspVoice.kActiveVoice;
            return voice;
        };

        private getPlayingVoice(pitch: number) {
            let playing_voice = DspVoice.kNoVoice;
            let oldest_date_playing = Number.MAX_VALUE;

            for (let voice = 0; voice < this.fInstance.voices; voice++) {
                if (this.fVoiceTable[voice].fNote === pitch) {
                    // Keeps oldest playing voice
                    if (this.fVoiceTable[voice].fDate < oldest_date_playing) {
                        oldest_date_playing = this.fVoiceTable[voice].fDate;
                        playing_voice = voice;
                    }
                }
            }
            return playing_voice;
        }

        private getFreeVoice() {
            for (let voice = 0; voice < this.fInstance.voices; voice++) {
                if (this.fVoiceTable[voice].fNote === DspVoice.kFreeVoice) return this.allocVoice(voice);
            }

            let voice_release = DspVoice.kNoVoice;
            let voice_playing = DspVoice.kNoVoice;
            let oldest_date_release = Number.MAX_VALUE;
            let oldest_date_playing = Number.MAX_VALUE;

            for (let voice = 0; voice < this.fInstance.voices; voice++) { // Scan all voices
                // Try to steal a voice in DspVoice.kReleaseVoice mode...
                if (this.fVoiceTable[voice].fNote === DspVoice.kReleaseVoice) {
                    // Keeps oldest release voice
                    if (this.fVoiceTable[voice].fDate < oldest_date_release) {
                        oldest_date_release = this.fVoiceTable[voice].fDate;
                        voice_release = voice;
                    }
                } else if (this.fVoiceTable[voice].fDate < oldest_date_playing) {
                    oldest_date_playing = this.fVoiceTable[voice].fDate;
                    voice_playing = voice;
                }
            }
            // Then decide which one to steal
            if (oldest_date_release !== Number.MAX_VALUE) {
                console.log(`Steal release voice : voice_date = ${this.fVoiceTable[voice_release].fDate} voice = ${voice_release}`);
                return this.allocVoice(voice_release);
            }
            if (oldest_date_playing !== Number.MAX_VALUE) {
                console.log(`Steal playing voice : voice_date = ${this.fVoiceTable[voice_playing].fDate} voice = ${voice_playing}`);
                return this.allocVoice(voice_playing);
            }
            return DspVoice.kNoVoice;
        }

        // Public API
        compute(input: Float32Array[], output: Float32Array[]) {
            // Check DSP state
            if (this.fDestroyed) return false;

            // Check inputs
            if (this.getNumInputs() > 0 && (!input || !input[0] || input[0].length === 0)) {
                // console.log("Process input error");
                return true;
            }

            // Check outputs
            if (this.getNumOutputs() > 0 && (!output || !output[0] || output[0].length === 0)) {
                // console.log("Process output error");
                return true;
            }

            // Copy inputs
            if (input !== undefined) {
                for (let chan = 0; chan < Math.min(this.getNumInputs(), input.length); ++chan) {
                    const dspInput = this.fInChannels[chan];
                    dspInput.set(input[chan]);
                }
            }

            // Possibly call an externally given callback (for instance to synchronize playing a MIDIFile...)
            if (this.fComputeHandler) this.fComputeHandler(this.fBufferSize);

            // Compute
            this.fInstance.mixer_api.clearOutput(this.fBufferSize, this.getNumOutputs(), this.fAudioOutputs);
            this.fVoiceTable.forEach(voice => {
                voice.compute(this.fBufferSize, this.fAudioInputs, this.fAudioMixing);
                this.fInstance.mixer_api.mixVoice(this.fBufferSize, this.getNumOutputs(), this.fAudioMixing, this.fAudioOutputs);
            });
            if (this.fInstance.effect_api) this.fInstance.effect_api.compute(this.fEffect, this.fBufferSize, this.fAudioOutputs, this.fAudioOutputs);

            // Update bargraph
            this.updateOutputs();

            if (output !== undefined) {
                // Copy outputs
                for (let chan = 0; chan < Math.min(this.getNumOutputs(), output.length); chan++) {
                    const dspOutput = this.fOutChannels[chan];
                    output[chan].set(dspOutput);
                }

                // PlotHandler handling 
                if (this.fPlotHandler) {
                    this.fPlotHandler(output, this.fBufferNum++, (this.fCachedEvents.length ? this.fCachedEvents : undefined));
                    this.fCachedEvents = [];
                }
            }

            return true;
        }
        getNumInputs() {
            return this.fInstance.voice_api.getNumInputs(0);
        }
        getNumOutputs() {
            return this.fInstance.voice_api.getNumOutputs(0);
        }

        private static findPath(o: any, p: string) {
            if (typeof o !== "object") {
                return false;
            } else if (o.address) {
                return (o.address === p);
            } else {
                for (const k in o) {
                    if (PolyDSPImp.findPath(o[k], p)) return true;
                }
                return false;
            }
        }

        setParamValue(path: string, value: number) {
            if (this.fPlotHandler) this.fCachedEvents.push({ type: "param", data: { path, value } });
            if (this.fJSONEffect && PolyDSPImp.findPath(this.fJSONEffect.ui, path) && this.fInstance.effect_api) {
                this.fInstance.effect_api.setParamValue(this.fEffect, this.fPathTable[path], value);
            } else {
                this.fVoiceTable.forEach(voice => { voice.setParamValue(this.fPathTable[path], value); });
            }
        }
        getParamValue(path: string) {
            if (this.fJSONEffect && PolyDSPImp.findPath(this.fJSONEffect.ui, path) && this.fInstance.effect_api) {
                return this.fInstance.effect_api.getParamValue(this.fEffect, this.fPathTable[path]);
            } else {
                return this.fVoiceTable[0].getParamValue(this.fPathTable[path]);
            }
        }

        getJSON() {
            const o = this.fJSONDsp;
            const e = this.fJSONEffect;
            const r = { ...o };
            if (e) {
                r.ui = [{
                    type: "tgroup", label: "Sequencer", items: [
                        { type: "vgroup", label: "Instrument", items: o.ui },
                        { type: "vgroup", label: "Effect", items: e.ui }
                    ]
                }];
            } else {
                r.ui = [{
                    type: "tgroup", label: "Polyphonic", items: [
                        { type: "vgroup", label: "Voices", items: o.ui }
                    ]
                }];
            }
            return JSON.stringify(r);
        }

        getUI() {
            const o = this.fJSONDsp;
            const e = this.fJSONEffect;
            const r = { ...o };
            if (e) {
                return [{
                    type: "tgroup", label: "Sequencer", items: [
                        { type: "vgroup", label: "Instrument", items: o.ui },
                        { type: "vgroup", label: "Effect", items: e.ui }
                    ]
                }] as TFaustUI;
            } else {
                return [{
                    type: "tgroup", label: "Polyphonic", items: [
                        { type: "vgroup", label: "Voices", items: o.ui }
                    ]
                }] as TFaustUI;
            }
        }

        midiMessage(data: number[] | Uint8Array) {
            // TODO: node.cachedEvents.push({ data, type: "midi" });
            const cmd = data[0] >> 4;
            const channel = data[0] & 0xf;
            const data1 = data[1];
            const data2 = data[2];
            if (cmd === 8 || (cmd === 9 && data2 === 0)) return this.keyOff(channel, data1, data2);
            else if (cmd === 9) return this.keyOn(channel, data1, data2);
            else super.midiMessage(data);
        };

        ctrlChange(channel: number, ctrl: number, value: number) {
            if (ctrl === 123 || ctrl === 120) {
                this.allNotesOff(true);
            } else {
                super.ctrlChange(channel, ctrl, value);
            }
        }

        keyOn(channel: number, pitch: number, velocity: number) {
            let voice = this.getFreeVoice();
            this.fVoiceTable[voice].keyOn(pitch, velocity);
        }

        keyOff(channel: number, pitch: number, velocity: number) {
            let voice = this.getPlayingVoice(pitch);
            if (voice !== DspVoice.kNoVoice) {
                this.fVoiceTable[voice].keyOff();
            } else {
                console.log("Playing pitch = %d not found\n", pitch);
            }
        }

        allNotesOff(hard: boolean = true) {
            this.fCachedEvents.push({ type: "ctrlChange", data: [0, 123, 0] });
            this.fVoiceTable.forEach(voice => voice.keyOff(hard));
        }
    }
}