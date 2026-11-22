package com.example.sbex.lakehouse;

import java.io.IOException;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.text.PDFTextStripper;

/**
 * The extraction worker's entry point: PDF bytes on stdin, text on stdout.
 *
 * It is a main class of its own rather than a thread because the boundary is
 * the process (docs/d205): the parent caps its heap and its wall clock, and a
 * parser crash cannot reach the appender. Bouncycastle is excluded from the
 * dependency set, so an encrypted PDF fails here the way upstream fails — as a
 * capture that could not be indexed.
 */
public final class PdfWorker {

	private PdfWorker() {
	}

	/**
	 * @param args one optional output path; a path is used because the parent's
	 *     read of it is cap-checked and a logging binding cannot corrupt it the
	 *     way it corrupts stdout
	 */
	public static void main(String[] args) {
		try {
			byte[] data = System.in.readAllBytes();
			try (PDDocument document = Loader.loadPDF(data)) {
				String text = new PDFTextStripper().getText(document).strip();
				if (args.length > 0) {
					java.nio.file.Files.writeString(java.nio.file.Path.of(args[0]), text);
				} else {
					System.out.write(text.getBytes(java.nio.charset.StandardCharsets.UTF_8));
				}
			}
		} catch (IOException | RuntimeException failure) {
			new java.io.PrintWriter(new java.io.OutputStreamWriter(
				System.err, java.nio.charset.StandardCharsets.UTF_8), true).println(failure);
			System.exit(1);
		}
	}
}
