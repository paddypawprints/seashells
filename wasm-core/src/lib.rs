use wasm_bindgen::prelude::*;
use js_sys::{Float32Array, Uint32Array};

// ---------------------------------------------------------------------------
// Pure Rust implementations (no js-sys types → testable with `cargo test`)
// ---------------------------------------------------------------------------

/// Core NMS logic operating on plain Rust slices.
/// Returns a `Vec<u32>` of kept indices sorted by descending score.
pub fn nms_inner(boxes: &[f32], scores: &[f32], iou_threshold: f32) -> Vec<u32> {
    let n = scores.len();
    let mut indices: Vec<usize> = (0..n).collect();
    indices.sort_unstable_by(|&a, &b| {
        scores[b]
            .partial_cmp(&scores[a])
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut kept: Vec<u32> = Vec::new();
    let mut suppressed = vec![false; n];

    for i in 0..indices.len() {
        let idx = indices[i];
        if suppressed[idx] {
            continue;
        }
        kept.push(idx as u32);

        let x1_a = boxes[idx * 4];
        let y1_a = boxes[idx * 4 + 1];
        let x2_a = boxes[idx * 4 + 2];
        let y2_a = boxes[idx * 4 + 3];
        let area_a = (x2_a - x1_a).max(0.0) * (y2_a - y1_a).max(0.0);

        for &idx2 in indices.iter().skip(i + 1) {
            if suppressed[idx2] {
                continue;
            }

            let x1_b = boxes[idx2 * 4];
            let y1_b = boxes[idx2 * 4 + 1];
            let x2_b = boxes[idx2 * 4 + 2];
            let y2_b = boxes[idx2 * 4 + 3];
            let area_b = (x2_b - x1_b).max(0.0) * (y2_b - y1_b).max(0.0);

            let inter_x1 = x1_a.max(x1_b);
            let inter_y1 = y1_a.max(y1_b);
            let inter_x2 = x2_a.min(x2_b);
            let inter_y2 = y2_a.min(y2_b);

            let inter_area =
                (inter_x2 - inter_x1).max(0.0) * (inter_y2 - inter_y1).max(0.0);
            let union_area = area_a + area_b - inter_area;

            if union_area > 0.0 && inter_area / union_area > iou_threshold {
                suppressed[idx2] = true;
            }
        }
    }
    kept
}

/// Read one pixel's normalised RGB (0..1) from a flat RGBA byte buffer.
#[inline(always)]
pub fn pixel_rgb(rgba: &[u8], x: usize, y: usize, w: usize) -> [f32; 3] {
    let base = (y * w + x) * 4;
    if base + 2 < rgba.len() {
        [
            rgba[base] as f32 / 255.0,
            rgba[base + 1] as f32 / 255.0,
            rgba[base + 2] as f32 / 255.0,
        ]
    } else {
        [0.0, 0.0, 0.0]
    }
}

/// Core crop-and-normalise logic operating on plain Rust slices.
/// Returns `Vec<f32>` of shape `[N * 3 * OUT_SIZE * OUT_SIZE]`.
pub fn crop_and_normalize_inner(
    rgba: &[u8],
    img_width: usize,
    img_height: usize,
    bboxes: &[f32],
) -> Vec<f32> {
    const OUT_SIZE: usize = 112;
    const MEAN: [f32; 3] = [0.5, 0.5, 0.5];
    const STD: [f32; 3]  = [0.5, 0.5, 0.5];

    let n = bboxes.len() / 4;
    let out_len = n * 3 * OUT_SIZE * OUT_SIZE;
    let mut out = vec![0f32; out_len];

    let w = img_width;
    let h = img_height;

    for face_idx in 0..n {
        let x1 = (bboxes[face_idx * 4] as usize).min(w.saturating_sub(1));
        let y1 = (bboxes[face_idx * 4 + 1] as usize).min(h.saturating_sub(1));
        let x2 = (bboxes[face_idx * 4 + 2] as usize).min(w);
        let y2 = (bboxes[face_idx * 4 + 3] as usize).min(h);

        let crop_w = (x2.saturating_sub(x1)).max(1);
        let crop_h = (y2.saturating_sub(y1)).max(1);

        let offset = face_idx * 3 * OUT_SIZE * OUT_SIZE;

        for oy in 0..OUT_SIZE {
            let src_y_f =
                (oy as f32 + 0.5) * (crop_h as f32) / (OUT_SIZE as f32) - 0.5;
            let src_y0 = (src_y_f.floor() as isize).max(0) as usize;
            let src_y1_idx = (src_y0 + 1).min(crop_h.saturating_sub(1));
            let dy = (src_y_f - src_y0 as f32).clamp(0.0, 1.0);

            for ox in 0..OUT_SIZE {
                let src_x_f =
                    (ox as f32 + 0.5) * (crop_w as f32) / (OUT_SIZE as f32) - 0.5;
                let src_x0 = (src_x_f.floor() as isize).max(0) as usize;
                let src_x1_idx = (src_x0 + 1).min(crop_w.saturating_sub(1));
                let dx = (src_x_f - src_x0 as f32).clamp(0.0, 1.0);

                let ax0 = x1 + src_x0;
                let ax1 = x1 + src_x1_idx;
                let ay0 = y1 + src_y0;
                let ay1 = y1 + src_y1_idx;

                let p00 = pixel_rgb(rgba, ax0, ay0, w);
                let p10 = pixel_rgb(rgba, ax1, ay0, w);
                let p01 = pixel_rgb(rgba, ax0, ay1, w);
                let p11 = pixel_rgb(rgba, ax1, ay1, w);

                for c in 0..3usize {
                    let val = (p00[c] * (1.0 - dx) + p10[c] * dx) * (1.0 - dy)
                        + (p01[c] * (1.0 - dx) + p11[c] * dx) * dy;
                    let norm = (val - MEAN[c]) / STD[c];
                    out[offset + c * OUT_SIZE * OUT_SIZE + oy * OUT_SIZE + ox] = norm;
                }
            }
        }
    }
    out
}

/// Core Euclidean distance on plain slices.
pub fn euclidean_distance_inner(a: &[f32], b: &[f32]) -> f32 {
    let len = a.len().min(b.len());
    let sum_sq: f32 = (0..len).map(|i| (a[i] - b[i]).powi(2)).sum();
    sum_sq.sqrt()
}

/// Core mean-vector computation on plain slices.
pub fn calculate_mean_inner(data: &[f32], dim: usize) -> Vec<f32> {
    let n = if dim == 0 { 0 } else { data.len() / dim };
    let mut mean = vec![0f32; dim];
    if n == 0 || dim == 0 {
        return mean;
    }
    for i in 0..n {
        for j in 0..dim {
            mean[j] += data[i * dim + j];
        }
    }
    for v in mean.iter_mut() {
        *v /= n as f32;
    }
    mean
}

// ---------------------------------------------------------------------------
// Wasm-bindgen public API (thin wrappers around the pure functions above)
// ---------------------------------------------------------------------------

/// Apply Non-Maximum Suppression on detection results.
///
/// # Arguments
/// * `boxes_js`      – flat `Float32Array` of shape `[N*4]` in `[x1,y1,x2,y2]` order.
/// * `scores_js`     – flat `Float32Array` of shape `[N]`.
/// * `iou_threshold` – IoU overlap threshold above which weaker boxes are suppressed.
///
/// # Returns
/// A `Uint32Array` of kept indices (sorted by descending score).
#[wasm_bindgen]
pub fn apply_nms(
    boxes_js: &Float32Array,
    scores_js: &Float32Array,
    iou_threshold: f32,
) -> Uint32Array {
    let boxes  = boxes_js.to_vec();
    let scores = scores_js.to_vec();
    let kept   = nms_inner(&boxes, &scores, iou_threshold);

    let result = Uint32Array::new_with_length(kept.len() as u32);
    for (i, &v) in kept.iter().enumerate() {
        result.set_index(i as u32, v);
    }
    result
}

/// Crop N face regions from raw RGBA `ImageData`, resize each to 112×112,
/// normalise with mean/std = 0.5/0.5, and pack into a contiguous `Float32Array`
/// of shape `[N, 3, 112, 112]` (channels-first / CHW).
///
/// # Arguments
/// * `image_data_js` – raw RGBA bytes (`Uint8Array`).
/// * `img_width`     – source image width in pixels.
/// * `img_height`    – source image height in pixels.
/// * `bboxes_js`     – flat `Float32Array` `[N*4]` as `[x1,y1,x2,y2]` pixel coords.
///
/// # Returns
/// `Float32Array` of length `N * 3 * 112 * 112`.
#[wasm_bindgen]
pub fn crop_and_normalize_batch(
    image_data_js: &js_sys::Uint8Array,
    img_width: u32,
    img_height: u32,
    bboxes_js: &Float32Array,
) -> Float32Array {
    let rgba   = image_data_js.to_vec();
    let bboxes = bboxes_js.to_vec();
    let out    = crop_and_normalize_inner(
        &rgba,
        img_width  as usize,
        img_height as usize,
        &bboxes,
    );
    let result = Float32Array::new_with_length(out.len() as u32);
    result.copy_from(&out);
    result
}

/// Compute the Euclidean distance between two equal-length `Float32Array` vectors.
#[wasm_bindgen]
pub fn euclidean_distance(vec1: &Float32Array, vec2: &Float32Array) -> f32 {
    let a = vec1.to_vec();
    let b = vec2.to_vec();
    euclidean_distance_inner(&a, &b)
}

/// Compute the element-wise mean of a batch of vectors packed as a flat
/// `Float32Array` of shape `[N * dim]`.
///
/// # Arguments
/// * `vectors_js` – flat `Float32Array`, length `N * dim`.
/// * `dim`        – dimensionality of each individual vector.
///
/// # Returns
/// `Float32Array` of length `dim`.
#[wasm_bindgen]
pub fn calculate_mean_vector(vectors_js: &Float32Array, dim: u32) -> Float32Array {
    let data = vectors_js.to_vec();
    let mean = calculate_mean_inner(&data, dim as usize);
    let result = Float32Array::new_with_length(mean.len() as u32);
    result.copy_from(&mean);
    result
}

// ---------------------------------------------------------------------------
// Tests — use the pure inner functions so `cargo test` works on any target.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nms_keeps_non_overlapping() {
        // Two completely separate boxes
        let boxes  = [0.0f32, 0.0, 1.0, 1.0, 2.0, 2.0, 3.0, 3.0];
        let scores = [0.9f32, 0.8];
        let kept = nms_inner(&boxes, &scores, 0.5);
        assert_eq!(kept.len(), 2);
    }

    #[test]
    fn nms_suppresses_overlapping() {
        // Two nearly identical boxes → only keep the higher-scoring one
        let boxes  = [0.0f32, 0.0, 1.0, 1.0, 0.05, 0.05, 1.05, 1.05];
        let scores = [0.9f32, 0.8];
        let kept = nms_inner(&boxes, &scores, 0.3);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0], 0);
    }

    #[test]
    fn nms_empty_input() {
        let kept = nms_inner(&[], &[], 0.5);
        assert!(kept.is_empty());
    }

    #[test]
    fn euclidean_distance_identical() {
        let v = [1.0f32, 2.0, 3.0];
        assert!(euclidean_distance_inner(&v, &v).abs() < 1e-6);
    }

    #[test]
    fn euclidean_distance_known() {
        let a = [0.0f32, 0.0];
        let b = [3.0f32, 4.0];
        let d = euclidean_distance_inner(&a, &b);
        assert!((d - 5.0).abs() < 1e-5, "expected 5.0, got {}", d);
    }

    #[test]
    fn mean_vector_single() {
        let v    = [1.0f32, 2.0, 3.0];
        let mean = calculate_mean_inner(&v, 3);
        assert!((mean[0] - 1.0).abs() < 1e-6);
        assert!((mean[1] - 2.0).abs() < 1e-6);
        assert!((mean[2] - 3.0).abs() < 1e-6);
    }

    #[test]
    fn mean_vector_multiple() {
        // two vectors [1,0] and [3,0] → mean [2,0]
        let v    = [1.0f32, 0.0, 3.0, 0.0];
        let mean = calculate_mean_inner(&v, 2);
        assert!((mean[0] - 2.0).abs() < 1e-6);
        assert!((mean[1] - 0.0).abs() < 1e-6);
    }

    #[test]
    fn mean_vector_empty_dim() {
        let mean = calculate_mean_inner(&[], 0);
        assert!(mean.is_empty());
    }

    #[test]
    fn crop_normalise_output_size() {
        // 4×4 image, single bounding box covering entire image
        let mut rgba = vec![0u8; 4 * 4 * 4];
        // Fill with a solid colour so we can check normalisation
        for i in 0..(4 * 4) {
            rgba[i * 4]     = 128; // R
            rgba[i * 4 + 1] = 64;  // G
            rgba[i * 4 + 2] = 32;  // B
            rgba[i * 4 + 3] = 255; // A
        }
        let bboxes = [0.0f32, 0.0, 4.0, 4.0];
        let out = crop_and_normalize_inner(&rgba, 4, 4, &bboxes);
        assert_eq!(out.len(), 3 * 112 * 112);
        // Every R channel pixel should be (128/255 - 0.5) / 0.5 ≈ 0.004
        let expected_r = (128.0f32 / 255.0 - 0.5) / 0.5;
        for &v in &out[..112 * 112] {
            assert!((v - expected_r).abs() < 0.01, "R channel: expected ~{:.4} got {:.4}", expected_r, v);
        }
    }
}
