export interface ParsedError {
  title: string;
  message: string;
  technical?: string;
}

export class ErrorParser {
  static parse(error: any): ParsedError {
    // Default error structure
    let title = 'Error';
    let message = 'An unexpected error occurred.';
    let technical = '';

    // If error is a string
    if (typeof error === 'string') {
      technical = error;

      // Extract just the actual error from verbose logs
      const errorMatch = error.match(/Claude request error: Error code: (\d+) - (.+)/);
      if (errorMatch) {
        const errorCode = errorMatch[1];
        const errorDetails = errorMatch[2];

        // Try to parse the JSON error details
        try {
          const jsonMatch = errorDetails.match(/\{[^}]+\}/);
          if (jsonMatch) {
            const errorObj = JSON.parse(jsonMatch[0]);
            if (errorObj.error && errorObj.error.message) {
              technical = `Error ${errorCode}: ${errorObj.error.message}`;
            }
          }
        } catch (e) {
          technical = `Error ${errorCode}: ${errorDetails}`;
        }
      }

      // Check for common patterns in error strings
      if (error.includes('model:') && (error.includes('not_found_error') || error.includes('404'))) {
        const modelMatch = error.match(/['"]?model['"]?:\s*['"]?([\w\-.:]+)['"]?/);
        if (modelMatch) {
          const modelName = modelMatch[1];
          title = 'Invalid AI Model';
          message = `The AI model "${modelName}" is not available.\n\nThis usually means:\n• The model name is misspelled\n• The model has been deprecated\n• You need to update to a newer model version\n\nPlease check your Settings and select a valid model.`;
        }
      } else if (error.includes('THREADS_NO_VIDEO:')) {
        // Named by backend/src/downloader/threads-extractor.ts. Checked ahead of the
        // generic status-code cases below so a Threads message can't be swallowed
        // by a stray number in the post code or caption.
        title = 'No Video in This Post';
        message = 'This Threads post doesn\'t contain a video — it\'s an image or text-only post.\n\nOnly Threads posts with video can be downloaded.';
      } else if (error.includes('THREADS_POST_UNAVAILABLE:')) {
        title = 'Threads Post Unavailable';
        message = 'Threads didn\'t return this post.\n\nThis usually means:\n• The post was deleted\n• The account is private\n• The post is age-restricted\n\nCheck the link in a browser while logged out to confirm it\'s publicly visible.';
      } else if (error.includes('404') && !error.includes('model:')) {
        title = 'Resource Not Found';
        message = 'The requested resource could not be found.';
      } else if (error.includes('401') || error.includes('Unauthorized')) {
        title = 'Authentication Error';
        message = 'Your API key is invalid or has expired. Please check your settings.';
      } else if (error.includes('429') || error.includes('rate limit')) {
        title = 'Rate Limited';
        message = 'Too many requests. Please wait a moment and try again.';
      } else if (error.includes('500') || error.includes('Internal Server Error')) {
        title = 'Server Error';
        message = 'The service is experiencing issues. Please try again later.';
      } else if (error.includes('ENOENT') || error.includes('does not exist')) {
        title = 'File Not Found';
        message = 'The specified file or directory could not be found.';
      } else if (error.includes('EACCES') || error.includes('permission denied')) {
        title = 'Permission Denied';
        message = 'You don\'t have permission to access this file or directory.';
      } else if (error.includes('yt-dlp') || error.includes('youtube-dl')) {
        title = 'Download Error';
        message = 'There was a problem downloading the video. Check if the URL is valid or if yt-dlp is properly installed.';
      } else if (error.includes('FFmpeg') || error.includes('ffmpeg')) {
        title = 'FFmpeg Error';
        message = 'There was an issue processing the media file. Make sure FFmpeg is installed correctly.';
      } else {
        // Use first line as message if it's not too long
        const firstLine = error.split('\n')[0];
        if (firstLine.length < 150) {
          message = firstLine;
        } else {
          message = error;
        }
      }
    }
    // If error is an Error object
    else if (error instanceof Error) {
      technical = error.message;
      title = error.name || 'Error';
      message = error.message;
    }
    // If error is an object with common error properties
    else if (error && typeof error === 'object') {
      if (error.error) {
        return this.parse(error.error);
      }
      if (error.message) {
        technical = error.message;
        message = error.message;
      }
      if (error.statusText) {
        title = error.statusText;
      }
    }

    return { title, message, technical };
  }

  static formatForDisplay(error: any): { title: string; message: string } {
    const parsed = this.parse(error);
    return {
      title: parsed.title,
      message: parsed.message
    };
  }

  static formatWithTechnical(error: any): { title: string; message: string } {
    const parsed = this.parse(error);

    let fullMessage = parsed.message;

    // If we have technical details that are different from the message, add them
    if (parsed.technical && parsed.technical !== parsed.message) {
      fullMessage += `\n\nTechnical details:\n${parsed.technical}`;
    }

    return {
      title: parsed.title,
      message: fullMessage
    };
  }
}
