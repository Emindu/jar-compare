import org.benf.cfr.reader.Main;
import java.io.*;

public class WebDecompiler {
    public static String decompileBase64(String base64) throws Exception {
        byte[] classBytes = java.util.Base64.getDecoder().decode(base64);
        
        File tempDir = new File("/files/temp");
        tempDir.mkdirs();
        File classFile = File.createTempFile("Decomp", ".class", tempDir);
        
        try (FileOutputStream fos = new FileOutputStream(classFile)) {
            fos.write(classBytes);
        }
        
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        PrintStream ps = new PrintStream(baos);
        PrintStream old = System.out;
        System.setOut(ps);
        try {
            Main.main(new String[]{classFile.getAbsolutePath(), "--silent", "true"});
        } catch (Exception e) {
            e.printStackTrace(ps);
        } finally {
            System.setOut(old);
            classFile.delete();
        }
        return java.util.Base64.getEncoder().encodeToString(baos.toByteArray());
    }

    public static void main(String[] args) {
        try {
            if (args.length > 0) {
                String result = decompileBase64(args[0]);
                System.out.println("DECOMPILED_B64_START");
                System.out.println(result);
                System.out.println("DECOMPILED_B64_END");
            }
        } catch (Exception e) {
            e.printStackTrace();
        }
    }
}
