import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, statSync } from 'fs';
import { basename } from 'path';
import { config } from '../core/Config.js';
import { logger } from '../utils/logger.js';
import { chunk, formatTimestamp } from '../utils/helpers.js';
import type { SceneFrame, VisualAnalysis, VisualType } from '../types/index.js';

/**
 * Service for analyzing video frames using Claude Vision API
 */
export class VisualAnalyzer {
  private client: Anthropic | null = null;

  /**
   * Check if the visual analyzer is available (has API key)
   */
  isAvailable(): boolean {
    return config.hasAnthropicKey();
  }

  /**
   * Initialize the Anthropic client
   */
  private getClient(): Anthropic {
    if (!this.client) {
      const apiKey = config.getApiKey('anthropic');
      if (!apiKey) {
        throw new Error(
          'Anthropic API key not configured. Set ANTHROPIC_API_KEY environment variable.'
        );
      }
      this.client = new Anthropic({ apiKey });
    }
    return this.client;
  }

  /**
   * Analyze multiple frames from a video
   */
  async analyzeFrames(
    frames: SceneFrame[],
    options?: {
      batchSize?: number;
      onProgress?: (message: string) => void;
    }
  ): Promise<VisualAnalysis[]> {
    if (!this.isAvailable()) {
      throw new Error('Anthropic API key not configured');
    }

    if (frames.length === 0) {
      return [];
    }

    const visualConfig = config.getVisual();
    const batchSize = options?.batchSize ?? 10; // Process up to 10 frames per API call

    logger.debug(`Analyzing ${frames.length} frames in batches of ${batchSize}`);

    const results: VisualAnalysis[] = [];
    const batches = chunk(frames, batchSize);

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      options?.onProgress?.(
        `Analyzing frames ${i * batchSize + 1}-${Math.min((i + 1) * batchSize, frames.length)}/${frames.length}...`
      );

      const batchResults = await this.analyzeBatch(batch, visualConfig.model);
      results.push(...batchResults);
    }

    return results;
  }

  /**
   * Analyze a batch of frames in a single API call
   */
  private async analyzeBatch(
    frames: SceneFrame[],
    model: string
  ): Promise<VisualAnalysis[]> {
    const client = this.getClient();

    // Build the message content with all images
    const content: Anthropic.MessageParam['content'] = [];

    // Add instruction text
    content.push({
      type: 'text',
      text: this.buildAnalysisPrompt(frames),
    });

    // Add all images
    for (const frame of frames) {
      const imageData = this.loadImageAsBase64(frame.framePath);
      if (imageData) {
        content.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: imageData.mediaType,
            data: imageData.data,
          },
        });
      }
    }

    // Make API call
    const response = await client.messages.create({
      model,
      max_tokens: 4096,
      messages: [
        {
          role: 'user',
          content,
        },
      ],
    });

    // Parse the response
    const responseText = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('\n');

    return this.parseAnalysisResponse(responseText, frames);
  }

  /**
   * Build the analysis prompt for a batch of frames
   */
  private buildAnalysisPrompt(frames: SceneFrame[]): string {
    const frameList = frames
      .map((f, i) => `Frame ${i + 1} (${formatTimestamp(f.timestamp)})`)
      .join(', ');

    return `Analyze these ${frames.length} frames from an educational/instructional video: ${frameList}

For EACH frame, provide a JSON object with:
- "frameIndex": the frame number (1-based)
- "description": what's being shown (slide content, diagram, code, UI, etc.) - be specific and detailed
- "extractedText": any visible text, code, or formulas transcribed verbatim (use empty string if none)
- "visualType": one of "slide", "code", "diagram", "terminal", "talking-head", or "other"

Focus on educational content - capture key information that would help someone understand the video without watching it.

Respond with a JSON array of objects, one per frame. Example:
[
  {
    "frameIndex": 1,
    "description": "Title slide showing 'Introduction to React Hooks'",
    "extractedText": "Introduction to React Hooks\\nLearn useState, useEffect, and custom hooks",
    "visualType": "slide"
  }
]

Analyze all ${frames.length} frames now:`;
  }

  /**
   * Load an image file as base64
   */
  private loadImageAsBase64(
    imagePath: string
  ): { data: string; mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' } | null {
    try {
      // Check file size (Claude has limits)
      const stats = statSync(imagePath);
      const maxSizeMB = 20; // 20MB limit per image
      if (stats.size > maxSizeMB * 1024 * 1024) {
        logger.warn(`Image ${basename(imagePath)} exceeds ${maxSizeMB}MB limit, skipping`);
        return null;
      }

      const buffer = readFileSync(imagePath);
      const data = buffer.toString('base64');

      // Determine media type from extension
      const ext = imagePath.toLowerCase().split('.').pop();
      const mediaTypes: Record<string, 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'> = {
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        gif: 'image/gif',
        webp: 'image/webp',
      };

      return {
        data,
        mediaType: mediaTypes[ext || 'png'] || 'image/png',
      };
    } catch (error) {
      logger.warn(`Failed to load image ${imagePath}: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * Parse the analysis response into structured data
   */
  private parseAnalysisResponse(
    responseText: string,
    frames: SceneFrame[]
  ): VisualAnalysis[] {
    try {
      // Extract JSON from the response (it might be wrapped in markdown code blocks)
      const jsonMatch = responseText.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        logger.warn('Could not find JSON array in response');
        return this.createFallbackAnalysis(frames);
      }

      const parsed = JSON.parse(jsonMatch[0]) as Array<{
        frameIndex: number;
        description: string;
        extractedText: string;
        visualType: string;
      }>;

      return parsed.map((item, index) => {
        const frameIndex = (item.frameIndex || index + 1) - 1;
        const frame = frames[frameIndex] || frames[index];

        return {
          timestamp: frame?.timestamp ?? index * 30,
          description: item.description || 'No description available',
          extractedText: item.extractedText || '',
          visualType: this.normalizeVisualType(item.visualType),
        };
      });
    } catch (error) {
      logger.warn(`Failed to parse analysis response: ${(error as Error).message}`);
      return this.createFallbackAnalysis(frames);
    }
  }

  /**
   * Normalize visual type to our enum
   */
  private normalizeVisualType(type: string): VisualType {
    const normalized = type?.toLowerCase().trim();
    const validTypes: VisualType[] = [
      'slide',
      'code',
      'diagram',
      'terminal',
      'talking-head',
      'other',
    ];

    if (validTypes.includes(normalized as VisualType)) {
      return normalized as VisualType;
    }

    // Map common variations
    if (normalized?.includes('code') || normalized?.includes('programming')) {
      return 'code';
    }
    if (normalized?.includes('slide') || normalized?.includes('presentation')) {
      return 'slide';
    }
    if (normalized?.includes('diagram') || normalized?.includes('chart') || normalized?.includes('graph')) {
      return 'diagram';
    }
    if (normalized?.includes('terminal') || normalized?.includes('console') || normalized?.includes('shell')) {
      return 'terminal';
    }
    if (normalized?.includes('person') || normalized?.includes('speaker') || normalized?.includes('face')) {
      return 'talking-head';
    }

    return 'other';
  }

  /**
   * Create fallback analysis when parsing fails
   */
  private createFallbackAnalysis(frames: SceneFrame[]): VisualAnalysis[] {
    return frames.map((frame) => ({
      timestamp: frame.timestamp,
      description: 'Visual content at this timestamp',
      extractedText: '',
      visualType: 'other' as VisualType,
    }));
  }

  /**
   * Analyze a single frame (convenience method)
   */
  async analyzeFrame(frame: SceneFrame): Promise<VisualAnalysis> {
    const results = await this.analyzeFrames([frame]);
    return results[0] || {
      timestamp: frame.timestamp,
      description: 'Analysis unavailable',
      extractedText: '',
      visualType: 'other',
    };
  }
}

// Export singleton instance
export const visualAnalyzer = new VisualAnalyzer();
